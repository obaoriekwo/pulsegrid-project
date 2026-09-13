// ============================================================
// PulseGrid — charts.js
// All Chart.js instances, keyed by canvas id, created once and
// updated in place on refresh / live push (avoids flicker/rebuild).
// ============================================================

const Charts = {}; // id -> Chart.js instance

const PALETTE = {
  accent: "#22D3B8",
  accentSoft: "rgba(34,211,184,0.15)",
  warn: "#F4B740",
  warnSoft: "rgba(244,183,64,0.15)",
  crit: "#FF5D5D",
  critSoft: "rgba(255,93,93,0.15)",
  indigo: "#6E7CFF",
  indigoSoft: "rgba(110,124,255,0.15)",
  textDim: "#93A0B4",
  grid: "rgba(255,255,255,0.06)",
};

Chart.defaults.color = PALETTE.textDim;
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.borderColor = PALETTE.grid;

function baseAxisOpts(extra = {}) {
  return {
    grid: { color: PALETTE.grid, drawTicks: false },
    ticks: { color: PALETTE.textDim, maxRotation: 0 },
    border: { display: false },
    ...extra,
  };
}

function upsertChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el) return null;
  if (Charts[canvasId]) {
    const c = Charts[canvasId];
    c.data = config.data;
    if (config.options) c.options = config.options;
    c.update("none");
    return c;
  }
  const chart = new Chart(el.getContext("2d"), config);
  Charts[canvasId] = chart;
  return chart;
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function hourKey(ts) {
  return new Date(ts).toISOString().slice(0, 13) + ":00";
}

function minuteKey(ts) {
  return new Date(ts).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

function groupBucketed(readings, valueFn, agg = "count", granularity = "day") {
  const keyFn = granularity === "minute" ? minuteKey : granularity === "hour" ? hourKey : dayKey;
  const buckets = {};
  for (const r of readings) {
    const k = keyFn(r.timestamp);
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(valueFn(r));
  }
  const keys = Object.keys(buckets).sort();
  const rawValues = keys.map((k) => {
    const vals = buckets[k];
    if (agg === "sum") return vals.reduce((a, b) => a + b, 0);
    if (agg === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.length; // count
  });

  // groupBucketed only creates a bucket for time slots that actually have a
  // reading - it does NOT fill in empty slots. For sparse events (e.g. a
  // handful of anomalies scattered across a long-running session), this
  // used to mean the line chart smoothly connected far-apart points as if
  // they were continuous, implying constant activity when the true picture
  // is isolated events separated by long silent gaps. Real bug, caught by
  // a user looking at a suspiciously flat "always 1" chart with a week-long
  // unexplained span in the labels.
  //
  // Fix: detect gaps between consecutive real points that are much larger
  // than a normal bucket step, and insert a null there. Combined with
  // spanGaps:false on the chart itself, Chart.js then draws a genuine
  // visual break instead of a misleading connecting line.
  const bucketMs = granularity === "minute" ? 60_000 : granularity === "hour" ? 3_600_000 : 86_400_000;
  const GAP_THRESHOLD_BUCKETS = 3; // gaps larger than this many bucket-widths get a break

  const days = [];
  const values = [];
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) {
      const prevMs = new Date(keys[i - 1]).getTime();
      const curMs = new Date(keys[i]).getTime();
      if (curMs - prevMs > bucketMs * GAP_THRESHOLD_BUCKETS) {
        // Insert a break just after the previous point so the line drops
        // out rather than smoothly connecting across the silent gap.
        days.push(null);
        values.push(null);
      }
    }
    days.push(keys[i]);
    values.push(rawValues[i]);
  }

  // If every bucket falls on the same calendar day, a bare time (HH:MM) is
  // unambiguous. If buckets span multiple days (e.g. one point from the
  // historical seed data, another from today's live simulator), a bare
  // time is misleading - two points from different days can show a time
  // that looks "out of order" even though the buckets are correctly
  // sorted chronologically. Include the date whenever that's possible.
  const distinctDays = new Set(keys.map((k) => k.slice(0, 10)));
  const spansMultipleDays = distinctDays.size > 1;
  const labels = granularity === "day"
    ? days.map((k) => k === null ? "" : k)
    : days.map((k) => {
        if (k === null) return "";
        const d = new Date(k);
        return spansMultipleDays
          ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      });

  // Real {x, y} points for a genuine time-scale axis (proportional spacing
  // by actual elapsed time, not equal-width categories - see the chart
  // configs that use this for why that distinction matters). Gap-break
  // nulls get an x placed at the midpoint between their two real
  // neighbors, so the break lands in the right place on a true time axis.
  const points = days.map((k, i) => {
    if (k !== null) return { x: k, y: values[i] };
    const prevMs = new Date(days[i - 1]).getTime();
    const nextMs = new Date(days[i + 1]).getTime();
    return { x: new Date((prevMs + nextMs) / 2).toISOString(), y: null };
  });

  return { days, labels, values, points };
}

function groupDaily(readings, valueFn, agg = "count") {
  const { days, values } = groupBucketed(readings, valueFn, agg, "day");
  return { days, values };
}

// ---------------- Overview page ----------------

function renderTrendChart(readings, metric = "temp") {
  const metricMap = {
    temp: { key: "temperature", label: "Temp (°C)", color: PALETTE.accent },
    vibration: { key: "vibration", label: "Vibration (m/s²)", color: PALETTE.warn },
    power: { key: "power", label: "Power (W)", color: PALETTE.indigo },
  };
  const m = metricMap[metric];
  const sorted = [...readings].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const recent = sorted.slice(-120);
  const labels = recent.map((r) => new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  const values = recent.map((r) => r[m.key]);

  upsertChart("chartTrend", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: m.label,
        data: values,
        borderColor: m.color,
        backgroundColor: m.color + "22",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        x: baseAxisOpts({ ticks: { color: PALETTE.textDim, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }),
        y: baseAxisOpts(),
      },
      plugins: { tooltip: { backgroundColor: "#10151F", borderColor: "#1E2733", borderWidth: 1 } },
    },
  });
}

function renderStatusDonut(readings) {
  const counts = {};
  for (const r of readings) {
    const s = r.operational_status || "Unknown";
    counts[s] = (counts[s] || 0) + 1;
  }
  const labels = Object.keys(counts);
  const colorFor = (l) => (l === "Operational" ? PALETTE.accent : l === "Under Maintenance" ? PALETTE.warn : PALETTE.crit);

  upsertChart("chartStatusDonut", {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: labels.map((l) => counts[l]), backgroundColor: labels.map(colorFor), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "68%" },
  });

  renderLegend("legendStatus", labels.map((l) => ({ label: l, value: counts[l], color: colorFor(l) })));
}

function renderDailyFaultsChart(readings) {
  const { points } = groupBucketed(readings.filter((r) => r.is_anomaly), () => 1, "count", "minute");
  upsertChart("chartDailyFaults", {
    type: "bar",
    data: { datasets: [{ label: "Faults", data: points, backgroundColor: PALETTE.crit, borderRadius: 4, maxBarThickness: 26 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: baseAxisOpts({ type: "time", time: { unit: "minute", displayFormats: { minute: "MMM d, HH:mm" } }, ticks: { color: PALETTE.textDim, autoSkip: true, maxTicksLimit: 8 } }),
        y: baseAxisOpts({ beginAtZero: true }),
      },
    },
  });
}

// ---------------- Live Sensors page ----------------

function renderMultiMetricChart(readings) {
  const sorted = [...readings].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(-100);
  const labels = sorted.map((r) => new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));

  upsertChart("chartMultiMetric", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Voltage (V)", data: sorted.map((r) => r.voltage), borderColor: PALETTE.indigo, pointRadius: 0, borderWidth: 1.5, tension: 0.3, yAxisID: "y" },
        { label: "Current (A ×40)", data: sorted.map((r) => r.current * 40), borderColor: PALETTE.warn, pointRadius: 0, borderWidth: 1.5, tension: 0.3, yAxisID: "y" },
        { label: "Power (W)", data: sorted.map((r) => r.power), borderColor: PALETTE.accent, pointRadius: 0, borderWidth: 1.5, tension: 0.3, yAxisID: "y" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 10, usePointStyle: true } } },
      scales: { x: baseAxisOpts({ ticks: { autoSkip: true, maxTicksLimit: 8 } }), y: baseAxisOpts() },
    },
  });
}

function renderScatterChart(readings) {
  const normal = readings.filter((r) => !r.is_anomaly).slice(-300);
  const anomalous = readings.filter((r) => r.is_anomaly);

  upsertChart("chartScatter", {
    type: "scatter",
    data: {
      datasets: [
        { label: "Normal", data: normal.map((r) => ({ x: r.temperature, y: r.vibration })), backgroundColor: PALETTE.indigoSoft, pointRadius: 3 },
        { label: "Fault event", data: anomalous.map((r) => ({ x: r.temperature, y: r.vibration })), backgroundColor: PALETTE.crit, pointRadius: 5, pointStyle: "triangle" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 10, usePointStyle: true } } },
      scales: {
        x: baseAxisOpts({ title: { display: true, text: "Temperature (°C)", color: PALETTE.textDim } }),
        y: baseAxisOpts({ title: { display: true, text: "Vibration (m/s²)", color: PALETTE.textDim } }),
      },
    },
  });
}

function renderExternalChart(readings) {
  const buckets = {};
  for (const r of readings) {
    const f = r.external_factors || "Unknown";
    if (!buckets[f]) buckets[f] = [];
    buckets[f].push(r.temperature);
  }
  const labels = Object.keys(buckets);
  const avgTemp = labels.map((l) => buckets[l].reduce((a, b) => a + b, 0) / buckets[l].length);
  const colors = [PALETTE.accent, PALETTE.warn, PALETTE.indigo, PALETTE.crit, "#7DD3FC", "#C084FC"];

  upsertChart("chartExternal", {
    type: "polarArea",
    data: { labels, datasets: [{ data: avgTemp, backgroundColor: labels.map((_, i) => colors[i % colors.length] + "55"), borderColor: labels.map((_, i) => colors[i % colors.length]) }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { ticks: { display: false }, grid: { color: PALETTE.grid } } } },
  });

  renderLegend("legendExternal", labels.map((l, i) => ({ label: l, value: avgTemp[i].toFixed(1) + "°C avg", color: colors[i % colors.length] })));
}

// ---------------- Equipment page ----------------

function renderCriticalityChart(equipment) {
  const counts = {};
  for (const e of equipment) counts[e.criticality] = (counts[e.criticality] || 0) + 1;
  const labels = Object.keys(counts);
  const colorFor = (l) => (l === "High" ? PALETTE.crit : l === "Medium" ? PALETTE.warn : PALETTE.accent);

  upsertChart("chartCriticality", {
    type: "doughnut",
    data: { labels, datasets: [{ data: labels.map((l) => counts[l]), backgroundColor: labels.map(colorFor), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "68%" },
  });
  renderLegend("legendCriticality", labels.map((l) => ({ label: l, value: counts[l], color: colorFor(l) })));
}

function renderRelationshipChart(equipment) {
  const counts = {};
  for (const e of equipment) counts[e.relationship_type] = (counts[e.relationship_type] || 0) + 1;
  const labels = Object.keys(counts);
  const colors = [PALETTE.indigo, PALETTE.accent, PALETTE.warn];

  upsertChart("chartRelationship", {
    type: "doughnut",
    data: { labels, datasets: [{ data: labels.map((l) => counts[l]), backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "68%" },
  });
  renderLegend("legendRelationship", labels.map((l, i) => ({ label: l, value: counts[l], color: colors[i % colors.length] })));
}

// ---------------- Anomalies page ----------------

function renderFailureTypesChart(failureTypes) {
  const labels = Object.keys(failureTypes);
  const values = labels.map((l) => failureTypes[l]);
  upsertChart("chartFailureTypes", {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: PALETTE.crit, borderRadius: 4, maxBarThickness: 34 }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: { x: baseAxisOpts({ beginAtZero: true }), y: baseAxisOpts() },
    },
  });
}

function renderPMTrendChart(readings) {
  const { points } = groupBucketed(readings.filter((r) => r.predictive_maintenance_trigger), () => 1, "count", "minute");
  upsertChart("chartPMTrend", {
    type: "line",
    data: { datasets: [{ label: "PM triggers", data: points, borderColor: PALETTE.warn, backgroundColor: PALETTE.warnSoft, fill: true, tension: 0, pointRadius: 2, spanGaps: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        // Real time scale: spacing is proportional to actual elapsed time,
        // so a 10-minute gap genuinely looks 10x wider than a 1-minute one
        // - a plain category axis (the old setup) gave every gap equal
        // width regardless of real duration, which was its own honesty
        // problem even after the gap-break fix.
        x: baseAxisOpts({ type: "time", time: { unit: "minute", displayFormats: { minute: "MMM d, HH:mm" } }, ticks: { autoSkip: true, maxTicksLimit: 8 } }),
        y: baseAxisOpts({ beginAtZero: true }),
      },
    },
  });
}

// ---------------- Maintenance page ----------------

function renderMaintCostChart(maintenance) {
  // "day" granularity, not "minute": the historical seed CSV's Last
  // Maintenance Date column is date-only (verified: exactly one unique
  // value, 2024-12-01, across all 100 historical records - there was never
  // real time-of-day resolution to bucket by minute). Minute-bucketing
  // summed all 100 historical records into one artificial-looking spike
  // at midnight - a real bug, not a rendering-gap issue like the PM
  // Triggers chart. Live-simulated maintenance records do have real
  // per-minute timestamps, but a daily view is the honest, meaningful
  // resolution for a cost-trend chart either way.
  const asReadingsShape = maintenance.map((m) => ({ ...m, timestamp: m.date }));
  const { points } = groupBucketed(asReadingsShape, (m) => m.cost_usd, "sum", "day");
  upsertChart("chartMaintCost", {
    type: "line",
    data: { datasets: [{ label: "Cost (USD)", data: points, borderColor: PALETTE.indigo, backgroundColor: PALETTE.indigoSoft, fill: true, tension: 0, pointRadius: 2, spanGaps: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: baseAxisOpts({ type: "time", time: { unit: "day", displayFormats: { day: "MMM d, yyyy" } }, ticks: { autoSkip: true, maxTicksLimit: 8 } }),
        y: baseAxisOpts({ beginAtZero: true }),
      },
    },
  });
}

function renderMaintTypeChart(maintenance) {
  const types = ["Preventive", "Corrective"];
  const cost = types.map((t) => maintenance.filter((m) => m.maintenance_type === t).reduce((a, b) => a + b.cost_usd, 0));
  const repairTime = types.map((t) => {
    const rows = maintenance.filter((m) => m.maintenance_type === t);
    return rows.length ? rows.reduce((a, b) => a + b.repair_time_hrs, 0) / rows.length : 0;
  });

  upsertChart("chartMaintType", {
    type: "bar",
    data: {
      labels: types,
      datasets: [
        { label: "Total cost (USD)", data: cost, backgroundColor: PALETTE.indigo, borderRadius: 4, yAxisID: "y" },
        { label: "Avg repair time (hrs)", data: repairTime, backgroundColor: PALETTE.warn, borderRadius: 4, yAxisID: "y1" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 10, usePointStyle: true } } },
      scales: {
        x: baseAxisOpts(),
        y: baseAxisOpts({ beginAtZero: true, position: "left" }),
        y1: baseAxisOpts({ beginAtZero: true, position: "right", grid: { display: false } }),
      },
    },
  });
}

// ---------------- Shared legend renderer ----------------

function renderLegend(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = items
    .map((i) => `<span><span class="dot" style="background:${i.color}"></span>${i.label} — ${i.value}</span>`)
    .join("");
}
