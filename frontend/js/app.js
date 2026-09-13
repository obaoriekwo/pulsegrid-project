// ============================================================
// PulseGrid — app.js
// Page navigation, table rendering (search/sort), KPI cards,
// the Run Ingestion page, and the live WebSocket feed.
// ============================================================

const state = {
  currentPage: "overview",
  trendMetric: "temp",
  sort: {}, // per-table {key, dir}
  search: {},
};

// ---------------- Navigation ----------------

function goToPage(page) {
  state.currentPage = page;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));

  const titles = {
    overview: ["Real-Time Overview", "Time-series telemetry & anomaly detection across the sensor fleet"],
    sensors: ["Live Sensors", "Multi-metric telemetry streaming from the fleet"],
    equipment: ["Equipment", "Directory, criticality, and dependency structure"],
    anomalies: ["Anomalies", "Model-flagged fault events & predictive maintenance triggers"],
    maintenance: ["Maintenance", "Cost and repair-time history by maintenance type"],
    etl: ["Run Ingestion Pipeline", "Ingest → validate → detect anomalies → publish"],
  };
  const [title, sub] = titles[page] || ["PulseGrid", ""];
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageSub").textContent = sub;

  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("scrim").classList.remove("show");

  renderCurrentPage();
}

// ---------------- KPI cards ----------------

function kpiCard(label, value, sub = "", accentClass = "") {
  return `<div class="kpi-card ${accentClass}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
  </div>`;
}

function renderOverviewKpis() {
  const o = Store.overview;
  if (!o) return;
  const impactEl = document.getElementById("impactAnomalyRate");
  if (impactEl) impactEl.textContent = `${o.anomaly_rate_pct}%`;
  document.getElementById("kpi-grid-overview").innerHTML = [
    kpiCard("Sensors", o.sensor_count.toLocaleString(), `${o.equipment_count} equipment units`),
    kpiCard("Total Readings", o.total_readings.toLocaleString(), "ingested to date"),
    kpiCard("Anomalies Detected", o.anomaly_count.toLocaleString(), `${o.anomaly_rate_pct}% of readings`, "accent-crit"),
    kpiCard("PM Triggers", o.pm_trigger_count.toLocaleString(), "flagged for predictive maintenance", "accent-warn"),
    kpiCard("Avg Temp", o.avg_temperature + "°C", "fleet-wide", "accent-live"),
    kpiCard("Avg Vibration", o.avg_vibration + " m/s²", "fleet-wide", "accent-live"),
  ].join("");
}

function renderSensorsKpis() {
  const r = Store.readings;
  const avg = (k) => (r.reduce((a, b) => a + b[k], 0) / (r.length || 1)).toFixed(2);
  document.getElementById("kpi-grid-sensors").innerHTML = [
    kpiCard("Sensors Reporting", new Set(r.map((x) => x.sensor_id)).size.toLocaleString()),
    kpiCard("Avg Voltage", avg("voltage") + " V"),
    kpiCard("Avg Power", avg("power") + " W"),
    kpiCard("Anomalous Readings", r.filter((x) => x.is_anomaly).length, "in current window", "accent-crit"),
  ].join("");
}

function renderEquipmentKpis() {
  const e = Store.equipment;
  document.getElementById("kpi-grid-equipment").innerHTML = [
    kpiCard("Equipment Units", e.length),
    kpiCard("High Criticality", e.filter((x) => x.criticality === "High").length, "", "accent-crit"),
    kpiCard("Total Faults", e.reduce((a, b) => a + b.fault_count, 0), "", "accent-crit"),
    kpiCard("Total Maint. Cost", "$" + e.reduce((a, b) => a + b.total_maintenance_cost, 0).toLocaleString()),
  ].join("");
}

function computeSeverityThresholds(anomalies) {
  const scores = anomalies
    .map((a) => a.anomaly_score)
    .filter((s) => s !== null && s !== undefined)
    .sort((a, b) => a - b);
  if (!scores.length) return { severe: -0.15, moderate: -0.05 };
  const at = (p) => scores[Math.min(scores.length - 1, Math.floor(p * (scores.length - 1)))];
  // Most-negative 20% of this batch's scores = Severe, next 30% = Moderate,
  // rest = Mild. Relative to the actual score spread rather than a guessed
  // absolute cutoff, since IsolationForest's score range varies by dataset.
  return { severe: at(0.2), moderate: at(0.5) };
}

function renderAnomaliesKpis() {
  const a = Store.anomalies;
  const { severe } = computeSeverityThresholds(a);
  const critical = a.filter((x) => x.anomaly_score !== null && x.anomaly_score <= severe).length;
  document.getElementById("kpi-grid-anomalies").innerHTML = [
    kpiCard("Total Anomalies", a.length, "", "accent-crit"),
    kpiCard("Severe (bottom 20% by score)", critical, "", "accent-crit"),
    kpiCard("PM Triggers Active", a.filter((x) => x.predictive_maintenance_trigger).length, "", "accent-warn"),
    kpiCard("Equipment Affected", new Set(a.map((x) => x.equipment_id)).size),
  ].join("");
}

function renderMaintenanceKpis() {
  const m = Store.maintenance;
  const totalCost = m.reduce((a, b) => a + b.cost_usd, 0);
  const avgRepair = (m.reduce((a, b) => a + b.repair_time_hrs, 0) / (m.length || 1)).toFixed(1);
  document.getElementById("kpi-grid-maintenance").innerHTML = [
    kpiCard("Total Records", m.length),
    kpiCard("Total Cost", "$" + totalCost.toLocaleString()),
    kpiCard("Avg Repair Time", avgRepair + " hrs"),
    kpiCard("Preventive Share", Math.round(100 * m.filter((x) => x.maintenance_type === "Preventive").length / (m.length || 1)) + "%", "", "accent-live"),
  ].join("");
}

// ---------------- Tables (search + sort) ----------------

function wireTable(tableId, searchId, rowsGetter, rowRenderer, defaultSort) {
  const table = document.getElementById(tableId);
  if (!table) return;
  if (!state.sort[tableId]) state.sort[tableId] = defaultSort;

  const draw = () => {
    let rows = rowsGetter();
    const q = (state.search[tableId] || "").toLowerCase();
    if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));

    const { key, dir } = state.sort[tableId];
    if (key && key !== "rank") {
      rows = [...rows].sort((a, b) => {
        const av = a[key], bv = b[key];
        if (typeof av === "number" && typeof bv === "number") return dir * (av - bv);
        return dir * String(av ?? "").localeCompare(String(bv ?? ""));
      });
    }
    const tbody = table.querySelector("tbody");
    tbody.innerHTML = rows.map((r, i) => rowRenderer(r, i)).join("") || `<tr><td colspan="12" style="color:var(--text-faint);text-align:center;padding:20px;">No matching rows</td></tr>`;
  };

  table.querySelectorAll("th[data-key]").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      const cur = state.sort[tableId];
      state.sort[tableId] = { key, dir: cur.key === key ? -cur.dir : 1 };
      draw();
    };
  });

  if (searchId) {
    const input = document.getElementById(searchId);
    if (input) input.oninput = () => { state.search[tableId] = input.value; draw(); };
  }

  draw();
}

function fmtTime(ts) { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

function statusBadge(status) {
  const cls = status === "Operational" ? "badge-ok" : status === "Under Maintenance" ? "badge-warn" : "badge-neutral";
  return `<span class="badge ${cls}">${status}</span>`;
}

function renderSensorsTable() {
  // Table stays capped at the 500 most recent readings even though the
  // wider Store.readings pool (fetched for chart trend-spread) is larger;
  // the API already returns readings ordered most-recent-first.
  wireTable("tableSensors", "searchSensors", () => Store.readings.slice(0, 500), (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${r.sensor_id}</td>
      <td>${r.equipment_id}</td>
      <td style="color:${r.is_anomaly ? "var(--crit)" : "inherit"}">${r.temperature.toFixed(1)}</td>
      <td>${r.vibration.toFixed(3)}</td>
      <td>${r.power.toFixed(1)}</td>
      <td>${statusBadge(r.operational_status)}</td>
    </tr>`, { key: "t", dir: -1 });
}

function renderTopEquipmentMini() {
  const top = [...Store.equipment].sort((a, b) => b.fault_count - a.fault_count).slice(0, 8);
  document.querySelector("#tableTopEquipmentMini tbody").innerHTML = top.map((e) => `
    <tr><td>${e.id}</td><td style="color:${e.fault_count > 0 ? "var(--crit)" : "inherit"}">${e.fault_count}</td></tr>
  `).join("");
}

function renderEquipmentTable() {
  wireTable("tableEquipment", "searchEquipment", () => Store.equipment, (e, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${e.id}</td>
      <td>${e.sensor_count}</td>
      <td><span class="badge ${e.criticality === "High" ? "badge-crit" : e.criticality === "Medium" ? "badge-warn" : "badge-ok"}">${e.criticality}</span></td>
      <td>${e.avg_temperature ?? "—"}</td>
      <td>${e.avg_vibration ?? "—"}</td>
      <td style="color:${e.fault_count > 0 ? "var(--crit)" : "inherit"}">${e.fault_count}</td>
      <td style="color:${e.pm_trigger_count > 0 ? "var(--warn)" : "inherit"}">${e.pm_trigger_count}</td>
      <td>$${e.total_maintenance_cost.toLocaleString()}</td>
    </tr>`, { key: "faults", dir: -1 });
}

function renderAnomaliesTable() {
  const { severe, moderate } = computeSeverityThresholds(Store.anomalies);
  wireTable("tableAnomalies", "searchAnomalies", () => Store.anomalies, (a, i) => {
    const eq = Store.equipment.find((e) => e.id === a.equipment_id);
    const severity = a.anomaly_score <= severe ? ["Severe", "badge-crit"] : a.anomaly_score <= moderate ? ["Moderate", "badge-warn"] : ["Mild", "badge-neutral"];
    return `<tr>
      <td>${i + 1}</td>
      <td>${fmtTime(a.timestamp)}</td>
      <td>${a.sensor_id}</td>
      <td>${a.equipment_id}</td>
      <td>${a.labeled_failure_type || "—"}</td>
      <td>${a.temperature.toFixed(1)}</td>
      <td>${a.vibration.toFixed(3)}</td>
      <td>${eq ? eq.criticality : "—"}</td>
      <td><span class="badge ${severity[1]}">${severity[0]}</span></td>
    </tr>`;
  }, { key: "t", dir: -1 });
}

function renderMaintTypeTable() {
  const types = ["Preventive", "Corrective"];
  const rows = types.map((t) => {
    const recs = Store.maintenance.filter((m) => m.maintenance_type === t);
    const totalCost = recs.reduce((a, b) => a + b.cost_usd, 0);
    const avgRepair = recs.length ? (recs.reduce((a, b) => a + b.repair_time_hrs, 0) / recs.length).toFixed(1) : "0";
    return `<tr><td>${t}</td><td>${recs.length}</td><td>${avgRepair} hrs</td><td>$${totalCost.toLocaleString()}</td></tr>`;
  });
  document.querySelector("#tableMaintType tbody").innerHTML = rows.join("");
}

// ---------------- Page render dispatch ----------------

function renderCurrentPage() {
  if (!Store.overview) return;
  switch (state.currentPage) {
    case "overview":
      renderOverviewKpis();
      renderTrendChart(Store.readings, state.trendMetric);
      renderStatusDonut(Store.readings);
      renderDailyFaultsChart(Store.anomalies);
      renderTopEquipmentMini();
      break;
    case "sensors":
      renderSensorsKpis();
      renderMultiMetricChart(Store.readings);
      renderScatterChart(Store.readings);
      renderExternalChart(Store.readings);
      renderSensorsTable();
      break;
    case "equipment":
      renderEquipmentKpis();
      renderCriticalityChart(Store.equipment);
      renderRelationshipChart(Store.equipment);
      renderEquipmentTable();
      break;
    case "anomalies":
      renderAnomaliesKpis();
      renderFailureTypesChart(Store.failureTypes);
      renderPMTrendChart(Store.anomalies);
      renderAnomaliesTable();
      break;
    case "maintenance":
      renderMaintenanceKpis();
      renderMaintCostChart(Store.maintenance);
      renderMaintTypeChart(Store.maintenance);
      renderMaintTypeTable();
      break;
    case "etl":
      renderEtlSourceGrid();
      break;
  }
}

// ---------------- Run Ingestion page ----------------

function renderEtlSourceGrid() {
  const o = Store.overview;
  if (!o) return;
  document.getElementById("sourceGrid").innerHTML = [
    ["Registered sensors", o.sensor_count],
    ["Equipment units", o.equipment_count],
    ["Readings ingested", o.total_readings],
    ["Anomalies to date", o.anomaly_count],
  ].map(([k, v]) => `<div class="source-card"><div class="k">${k}</div><div class="v">${v.toLocaleString()}</div></div>`).join("");
}

function setEtlStage(stageEl, status, detail) {
  stageEl.classList.remove("running", "done", "failed");
  const fill = stageEl.querySelector(".fill");
  const statusEl = stageEl.querySelector(".etl-stage-status");
  if (status === "running") { stageEl.classList.add("running"); fill.style.width = "60%"; statusEl.textContent = "Running…"; }
  else if (status === "success") { stageEl.classList.add("done"); fill.style.width = "100%"; statusEl.textContent = detail || "Done"; }
  else if (status === "failed") { stageEl.classList.add("failed"); fill.style.width = "100%"; statusEl.textContent = detail || "Failed"; }
  else if (status === "skipped") { fill.style.width = "40%"; statusEl.textContent = detail || "Skipped"; }
  else { fill.style.width = "0%"; statusEl.textContent = "Waiting"; }
}

function logLine(msg, cls = "info") {
  const log = document.getElementById("etlLog");
  const div = document.createElement("div");
  div.className = "line " + cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.prepend(div);
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

function applyPipelineRunToEtlPage(run) {
  const stages = document.querySelectorAll(".etl-stage");
  stages.forEach((s) => setEtlStage(s, null));
  (run.stage_log || []).forEach((entry) => {
    const el = document.querySelector(`.etl-stage[data-stage="${entry.stage}"]`);
    if (el) setEtlStage(el, entry.status, entry.detail);
    logLine(`${entry.stage.toUpperCase()} — ${entry.detail}`, entry.status === "failed" ? "err" : entry.status === "success" ? "ok" : "info");
  });
  document.getElementById("etlSummary").textContent =
    `Run #${run.id} · ${run.status} · ${run.readings_ingested} ingested · ${run.anomalies_detected} anomalies detected`;
}

async function runPipelineNow() {
  const btn = document.getElementById("runEtlBtn");
  btn.disabled = true;
  document.querySelectorAll(".etl-stage").forEach((s) => setEtlStage(s, "running"));
  logLine("Triggering manual pipeline run…");
  try {
    const run = await Api.runPipeline(30);
    applyPipelineRunToEtlPage(run);
    await refreshAllData(false);
    showToast(`Pipeline run #${run.id} complete — ${run.anomalies_detected} anomalies detected`);
  } catch (e) {
    logLine("Pipeline run failed: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// ---------------- Toast ----------------

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("toast");
  document.getElementById("toastMsg").textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ---------------- Signal strip (live waveform) ----------------

function pushWaveSample(value) {
  Store.liveWave.push(value);
  if (Store.liveWave.length > 48) Store.liveWave.shift();
  drawWave();
}

function drawWave() {
  const path = document.getElementById("sigWavePath");
  if (!path) return;
  const w = 800, h = 34, mid = h / 2;
  const pts = Store.liveWave;
  if (pts.length < 2) { path.setAttribute("d", `M0,${mid} L${w},${mid}`); return; }
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = max - min || 1;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => {
    const x = i * step;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  path.setAttribute("d", d);
}

// ---------------- Data refresh + WebSocket ----------------

async function refreshAllData(showSpinner = true) {
  const icon = document.getElementById("refreshIcon");
  if (showSpinner) icon.style.transition = "transform .6s"; icon.style.transform = "rotate(360deg)";
  try {
    await loadAll();
    document.getElementById("sidebar-status").textContent = `${Store.overview.sensor_count} sensors streaming`;
    document.getElementById("footRange").textContent = `· ${Store.overview.total_readings.toLocaleString()} readings`;
    renderCurrentPage();
  } finally {
    setTimeout(() => { icon.style.transform = "rotate(0deg)"; }, 600);
  }
}

function handleLiveMessage(msg) {
  if (msg.type === "conn") {
    if (msg.status === "open") logLine("Live WebSocket connected.", "ok");
    if (msg.status === "closed") logLine("Live WebSocket disconnected — retrying…", "err");
    return;
  }
  if (msg.type === "pipeline_run") {
    pushWaveSample(msg.anomalies_detected > 0 ? 60 + Math.random() * 40 : 20 + Math.random() * 20);
    document.getElementById("sigReadout").textContent =
      `${msg.readings_ingested} ingested · ${msg.anomalies_detected} anomalies · run #${msg.run_id}`;

    // Normalize: the WebSocket broadcast uses "run_id" for the run's ID
    // (see line ~404/412 below, which read msg.run_id directly), but
    // applyPipelineRunToEtlPage expects "id" (matching the POST /api/pipeline/run
    // response shape used by the manual-trigger button). Without this, a manual
    // run's correct "Run #22" briefly shown from the POST response gets
    // overwritten by "Run #undefined" moments later when this same run's
    // WebSocket broadcast arrives.
    if (state.currentPage === "etl") applyPipelineRunToEtlPage({ ...msg, id: msg.run_id });

    // Refresh underlying data in the background so charts/tables reflect
    // the new readings, without interrupting whatever the user is doing.
    refreshAllData(false).then(() => {
      if (msg.anomalies_detected > 0) {
        showToast(`⚠ ${msg.anomalies_detected} new anomal${msg.anomalies_detected === 1 ? "y" : "ies"} detected (run #${msg.run_id})`);
      }
    });
  }
}

// ---------------- Init ----------------

async function init() {
  document.querySelectorAll(".nav-item").forEach((btn) => btn.addEventListener("click", () => goToPage(btn.dataset.page)));
  document.getElementById("goEtlBtn").addEventListener("click", () => goToPage("etl"));
  document.getElementById("refreshBtn").addEventListener("click", () => refreshAllData(true));
  document.getElementById("runEtlBtn").addEventListener("click", runPipelineNow);

  document.getElementById("menuBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
    document.getElementById("scrim").classList.toggle("show");
  });
  document.getElementById("scrim").addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("scrim").classList.remove("show");
  });

  document.querySelectorAll("#trendToggle .pill").forEach((p) => {
    p.addEventListener("click", () => {
      document.querySelectorAll("#trendToggle .pill").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      state.trendMetric = p.dataset.metric;
      renderTrendChart(Store.readings, state.trendMetric);
    });
  });

  try {
    await loadAll();
    document.getElementById("sidebar-status").textContent = `${Store.overview.sensor_count} sensors streaming`;
    document.getElementById("footRange").textContent = `· ${Store.overview.total_readings.toLocaleString()} readings`;
  } catch (e) {
    showToast("Could not reach the API — is the backend running?");
    console.error(e);
  }

  goToPage("overview");
  connectLiveSocket(handleLiveMessage);
  setInterval(drawWave, 4000); // gentle idle animation between live pushes
}

document.addEventListener("DOMContentLoaded", init);
