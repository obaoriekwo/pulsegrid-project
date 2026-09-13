"""
The real ingestion pipeline: Ingest -> Validate -> Detect Anomalies -> Publish.

This is what the frontend's "Run Ingestion" page now actually triggers,
instead of playing a canned animation. Each stage does real work and the
result (including which readings were flagged anomalous by the trained
IsolationForest model) is persisted to Postgres and broadcast over the
WebSocket to any connected dashboard clients.
"""
import random
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.models import Sensor, Equipment, Reading, PipelineRun, MaintenanceRecord
from app.ml.anomaly_detector import AnomalyDetector, FEATURE_COLUMNS

# Plausible operating ranges per metric, used both to generate synthetic
# readings and to validate incoming ones during the "Validate" stage.
VALID_RANGES = {
    "voltage": (95, 135),
    "current": (0.05, 3.0),
    "temperature": (-10, 95),
    "power": (0, 450),
    "humidity": (10, 95),
    "vibration": (0.0, 3.0),
    "ambient_temperature": (-20, 55),
    "ambient_humidity": (5, 100),
}

EXTERNAL_FACTORS = ["Clear Weather", "Storm", "High Humidity", "Heatwave", "Normal"]

# Rolling-window predictive maintenance rule: if a sensor's last N readings
# have an anomaly rate at or above this threshold, flag predictive
# maintenance for its equipment (distinct from "this single reading is an
# outlier" - it's "this sensor has been trending unhealthy").
PM_WINDOW = 10
PM_ANOMALY_RATE_THRESHOLD = 0.3


def generate_synthetic_reading(sensor_id: str, equipment_id: str, anomaly_bias: float = 0.06, under_maintenance_bias: float = 0.04) -> dict:
    """
    Generate one plausible sensor reading. Stands in for a real device
    publishing telemetry (MQTT/HTTP from physical hardware), which isn't
    available in this environment. With small probability, injects a
    genuine out-of-range spike so the anomaly detector has something real
    to catch - it is NOT told which readings are anomalies; it has to
    figure that out from the numbers alone.
    """
    is_injected_anomaly = random.random() < anomaly_bias

    base = {
        "voltage": random.gauss(115, 4),
        "current": random.gauss(0.6, 0.15),
        "humidity": random.gauss(45, 8),
        "ambient_humidity": random.gauss(45, 10),
        "ambient_temperature": random.gauss(24, 5),
        "external_factors": random.choice(EXTERNAL_FACTORS),
    }
    base["temperature"] = random.gauss(24, 4)
    base["vibration"] = max(0.0, random.gauss(0.35, 0.1))
    base["power"] = base["voltage"] * base["current"] * random.uniform(0.85, 1.0)

    if is_injected_anomaly:
        # push one or two metrics into an out-of-band spike
        spike_metric = random.choice(["temperature", "vibration", "voltage", "current"])
        if spike_metric == "temperature":
            base["temperature"] += random.uniform(35, 60)
        elif spike_metric == "vibration":
            base["vibration"] += random.uniform(1.2, 2.2)
        elif spike_metric == "voltage":
            base["voltage"] += random.choice([-1, 1]) * random.uniform(15, 25)
        elif spike_metric == "current":
            base["current"] += random.uniform(1.0, 2.0)
        base["power"] = base["voltage"] * base["current"] * random.uniform(0.85, 1.1)

    return {
        "sensor_id": sensor_id,
        "equipment_id": equipment_id,
        "timestamp": datetime.now(timezone.utc).replace(tzinfo=None),
        # Real variation instead of a hardcoded constant - a small share of
        # readings reflect equipment currently offline for maintenance,
        # same as the historical seed data has.
        "operational_status": "Under Maintenance" if random.random() < under_maintenance_bias else "Operational",
        **base,
    }


def validate_reading(reading: dict) -> tuple[bool, str]:
    for col, (lo, hi) in VALID_RANGES.items():
        val = reading.get(col)
        if val is None:
            return False, f"missing field: {col}"
        # allow a generous margin above/below range before hard-rejecting -
        # true out-of-range values are still ingested (they're often the
        # anomalies we care about) but physically impossible values are not
        margin = (hi - lo) * 2
        if val < lo - margin or val > hi + margin:
            return False, f"{col}={val:.2f} outside plausible bounds"
    return True, "ok"


def run_pipeline(
    db: Session,
    detector: AnomalyDetector,
    n_readings: int = 25,
    triggered_by: str = "simulator",
) -> PipelineRun:
    """Execute one full ingest -> validate -> detect -> publish cycle."""
    run = PipelineRun(status="running", stage_log=[])
    db.add(run)
    db.commit()
    db.refresh(run)

    log = []

    def log_stage(stage, status, detail):
        log.append({
            "stage": stage, "status": status, "detail": detail,
            "at": datetime.utcnow().isoformat(),
        })

    # ---- Stage 1: Ingest ----
    sensor_ids = [row[0] for row in db.execute(select(Sensor.id)).all()]
    if not sensor_ids:
        log_stage("ingest", "failed", "no sensors registered")
        run.status = "failed"
        run.stage_log = log
        run.finished_at = datetime.utcnow()
        db.commit()
        return run

    sensor_equipment = dict(
        db.execute(select(Sensor.id, Sensor.equipment_id)).all()
    )

    chosen = random.sample(sensor_ids, k=min(n_readings, len(sensor_ids)))
    raw_readings = [
        generate_synthetic_reading(sid, sensor_equipment[sid]) for sid in chosen
    ]
    log_stage("ingest", "success", f"received {len(raw_readings)} readings from {len(chosen)} sensors")

    # ---- Stage 2: Validate ----
    valid, rejected = [], []
    for r in raw_readings:
        ok, reason = validate_reading(r)
        (valid if ok else rejected).append((r, reason))
    log_stage(
        "validate", "success" if valid else "failed",
        f"{len(valid)} passed, {len(rejected)} rejected"
        + (f" (e.g. {rejected[0][1]})" if rejected else ""),
    )

    # ---- Stage 3: Detect anomalies ----
    anomaly_count = 0
    persisted: list[Reading] = []
    if detector.is_ready():
        for r, _ in valid:
            score, is_anom = detector.score_one({k: r[k] for k in FEATURE_COLUMNS})
            reading = Reading(
                sensor_id=r["sensor_id"],
                equipment_id=r["equipment_id"],
                timestamp=r["timestamp"],
                voltage=r["voltage"], current=r["current"],
                temperature=r["temperature"], power=r["power"],
                humidity=r["humidity"], vibration=r["vibration"],
                ambient_temperature=r["ambient_temperature"],
                ambient_humidity=r["ambient_humidity"],
                external_factors=r["external_factors"],
                operational_status=r["operational_status"],
                anomaly_score=score,
                is_anomaly=is_anom,
                predictive_maintenance_trigger=False,  # set below, per-sensor
            )
            db.add(reading)
            persisted.append(reading)
            if is_anom:
                anomaly_count += 1
        log_stage("detect", "success", f"model flagged {anomaly_count} of {len(valid)} as anomalous")
    else:
        log_stage("detect", "skipped", "model not trained yet - run seed_data.py first")

    db.flush()

    # Rolling-window predictive maintenance rule, computed per sensor that
    # just received a new reading. When it fires, this is a real trigger to
    # act - so we log an actual corrective-maintenance record against that
    # equipment, the same way a real CMMS integration would. This is what
    # makes the Maintenance page's cost/trend data grow live instead of
    # staying frozen at the seeded historical snapshot.
    pm_flagged = 0
    for reading in persisted:
        recent = db.execute(
            select(Reading.is_anomaly)
            .where(Reading.sensor_id == reading.sensor_id)
            .order_by(Reading.timestamp.desc())
            .limit(PM_WINDOW)
        ).scalars().all()
        if recent:
            rate = sum(1 for x in recent if x) / len(recent)
            if rate >= PM_ANOMALY_RATE_THRESHOLD:
                reading.predictive_maintenance_trigger = True
                pm_flagged += 1
                db.add(MaintenanceRecord(
                    equipment_id=reading.equipment_id,
                    date=reading.timestamp,
                    maintenance_type="Corrective",
                    repair_time_hrs=round(random.uniform(1.0, 6.0), 1),
                    cost_usd=round(random.uniform(250, 500), 2),
                    failure_history=f"Auto-logged: predictive trigger on {reading.sensor_id}",
                ))

    # ---- Stage 4: Publish ----
    run.readings_ingested = len(valid)
    run.readings_rejected = len(rejected)
    run.anomalies_detected = anomaly_count
    run.status = "success"
    run.finished_at = datetime.utcnow()
    log_stage("publish", "success", f"{pm_flagged} sensors flagged for predictive maintenance")
    run.stage_log = log
    db.commit()
    db.refresh(run)

    return run
