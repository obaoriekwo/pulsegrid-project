from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.database import get_db
from app.models import Reading, Sensor, Equipment
from app.schemas import OverviewStats

router = APIRouter(prefix="/api/overview", tags=["overview"])


@router.get("", response_model=OverviewStats)
def get_overview(db: Session = Depends(get_db)):
    sensor_count = db.scalar(select(func.count(Sensor.id))) or 0
    equipment_count = db.scalar(select(func.count(Equipment.id))) or 0
    total_readings = db.scalar(select(func.count(Reading.id))) or 0
    anomaly_count = db.scalar(select(func.count(Reading.id)).where(Reading.is_anomaly.is_(True))) or 0
    pm_trigger_count = db.scalar(
        select(func.count(Reading.id)).where(Reading.predictive_maintenance_trigger.is_(True))
    ) or 0
    avg_temp = db.scalar(select(func.avg(Reading.temperature))) or 0.0
    avg_vib = db.scalar(select(func.avg(Reading.vibration))) or 0.0

    anomaly_rate = (anomaly_count / total_readings * 100) if total_readings else 0.0

    return OverviewStats(
        sensor_count=sensor_count,
        equipment_count=equipment_count,
        total_readings=total_readings,
        anomaly_count=anomaly_count,
        anomaly_rate_pct=round(anomaly_rate, 2),
        pm_trigger_count=pm_trigger_count,
        avg_temperature=round(float(avg_temp), 2),
        avg_vibration=round(float(avg_vib), 3),
        # Deliberately NOT claiming a measured downtime reduction figure -
        # we don't have before/after deployment data to back that up.
        downtime_hours_saved_estimate=None,
    )
