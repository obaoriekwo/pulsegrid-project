"""
One-time setup script:
  1. Create tables
  2. Load sensor_maintenance_data.csv into Postgres (equipment, sensors,
     readings, maintenance records)
  3. Train the IsolationForest anomaly detector on that historical data
     and save it to disk for the API to load at runtime

Run with:  python -m scripts.seed_data /path/to/sensor_maintenance_data.csv
"""
import sys
import os
import pandas as pd
from datetime import datetime

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.database import Base, engine, SessionLocal
from app.models import Equipment, Sensor, Reading, MaintenanceRecord
from app.ml.anomaly_detector import AnomalyDetector, FEATURE_COLUMNS
from app.config import settings


def load_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.rename(columns={
        "Sensor_ID": "sensor_id",
        "Timestamp": "timestamp",
        "Voltage (V)": "voltage",
        "Current (A)": "current",
        "Temperature (°C)": "temperature",
        "Power (W)": "power",
        "Humidity (%)": "humidity",
        "Vibration (m/s²)": "vibration",
        "Equipment_ID": "equipment_id",
        "Operational Status": "operational_status",
        "Fault Status": "labeled_fault_status",
        "Failure Type": "labeled_failure_type",
        "Last Maintenance Date": "last_maintenance_date",
        "Maintenance Type": "maintenance_type",
        "Failure History": "failure_history",
        "Repair Time (hrs)": "repair_time_hrs",
        "Maintenance Costs (USD)": "maintenance_costs",
        "Ambient Temperature (°C)": "ambient_temperature",
        "Ambient Humidity (%)": "ambient_humidity",
        "External Factors": "external_factors",
        "X": "x", "Y": "y", "Z": "z",
        "Equipment Relationship": "equipment_relationship",
        "Equipment Criticality": "equipment_criticality",
        "Fault Detected": "fault_detected_label",
        "Predictive Maintenance Trigger": "pm_trigger_label",
    })
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["last_maintenance_date"] = pd.to_datetime(df["last_maintenance_date"], errors="coerce")
    return df


def _clean(v):
    """Convert pandas NaN/NaT to a real Python None (mixed NaN/str values in
    the same insertmanyvalues batch otherwise corrupt column alignment)."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def seed(df: pd.DataFrame):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # wipe existing rows for a clean re-seed
        db.query(Reading).delete()
        db.query(MaintenanceRecord).delete()
        db.query(Sensor).delete()
        db.query(Equipment).delete()
        db.commit()

        equip_rows = (
            df.groupby("equipment_id")
            .agg(
                criticality=("equipment_criticality", "first"),
                relationship_type=("equipment_relationship", "first"),
                x=("x", "first"), y=("y", "first"), z=("z", "first"),
            )
            .reset_index()
        )
        for _, row in equip_rows.iterrows():
            db.add(Equipment(
                id=row["equipment_id"],
                criticality=_clean(row["criticality"]) or "Medium",
                relationship_type=_clean(row["relationship_type"]) or "Independent",
                x=float(row["x"]), y=float(row["y"]), z=float(row["z"]),
            ))
        db.commit()

        sensor_rows = df[["sensor_id", "equipment_id"]].drop_duplicates()
        for _, row in sensor_rows.iterrows():
            db.add(Sensor(id=row["sensor_id"], equipment_id=row["equipment_id"]))
        db.commit()

        batch = []
        for _, row in df.iterrows():
            batch.append(Reading(
                sensor_id=row["sensor_id"],
                equipment_id=row["equipment_id"],
                timestamp=row["timestamp"].to_pydatetime(),
                voltage=float(row["voltage"]),
                current=float(row["current"]),
                temperature=float(row["temperature"]),
                power=float(row["power"]),
                humidity=float(row["humidity"]),
                vibration=float(row["vibration"]),
                ambient_temperature=float(row["ambient_temperature"]),
                ambient_humidity=float(row["ambient_humidity"]),
                external_factors=_clean(row["external_factors"]),
                operational_status=_clean(row["operational_status"]),
                labeled_fault_status=_clean(row["labeled_fault_status"]),
                labeled_failure_type=_clean(row["labeled_failure_type"]),
                # is_anomaly / anomaly_score / pm_trigger are left for the
                # model to fill in via the batch-scoring pass below -
                # NOT copied from the CSV's own labels.
            ))
        # Insert one at a time (still fast for 500 rows) to sidestep a
        # SQLAlchemy insertmanyvalues batching issue when a text column
        # mixes None and string values within the same compiled batch.
        for reading in batch:
            db.add(reading)
        db.commit()

        maint = df[[
            "equipment_id", "last_maintenance_date", "maintenance_type",
            "repair_time_hrs", "maintenance_costs", "failure_history",
        ]].dropna(subset=["last_maintenance_date"]).drop_duplicates()
        for _, row in maint.iterrows():
            db.add(MaintenanceRecord(
                equipment_id=row["equipment_id"],
                date=row["last_maintenance_date"].to_pydatetime(),
                maintenance_type=_clean(row["maintenance_type"]),
                repair_time_hrs=float(row["repair_time_hrs"]),
                cost_usd=float(row["maintenance_costs"]),
                failure_history=_clean(row["failure_history"]),
            ))
        db.commit()

        print(f"Seeded {len(equip_rows)} equipment, {len(sensor_rows)} sensors, "
              f"{len(df)} readings, {len(maint)} maintenance records.")
    finally:
        db.close()


def train_model(df: pd.DataFrame):
    detector = AnomalyDetector(settings.MODEL_PATH, settings.SCALER_PATH)
    stats = detector.train(df)
    print(f"Trained IsolationForest on {stats['n_samples']} historical readings; "
          f"flagged {stats['n_flagged']} as anomalous "
          f"({100 * stats['n_flagged'] / stats['n_samples']:.1f}%).")

    # Batch-score the historical data we just seeded so the dashboard has
    # real is_anomaly / anomaly_score values to show immediately, rather
    # than waiting for the simulator to generate new readings.
    from app.database import SessionLocal
    from app.models import Reading
    from sqlalchemy import select

    scores, is_anom = detector.score_batch(df)
    db = SessionLocal()
    try:
        readings = db.execute(
            select(Reading).order_by(Reading.id)
        ).scalars().all()
        assert len(readings) == len(df), "row count mismatch during scoring"
        for reading, score, anom in zip(readings, scores, is_anom):
            reading.anomaly_score = float(score)
            reading.is_anomaly = bool(anom)
        db.commit()
        print(f"Backfilled anomaly scores onto {len(readings)} seeded readings.")
    finally:
        db.close()


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "sensor_maintenance_data.csv"
    df = load_csv(csv_path)
    seed(df)
    train_model(df)
