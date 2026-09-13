from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, desc

from app.database import get_db
from app.models import Reading, Sensor
from app.schemas import ReadingOut

router = APIRouter(prefix="/api/sensors", tags=["sensors"])


@router.get("", response_model=list[str])
def list_sensor_ids(db: Session = Depends(get_db)):
    return [row[0] for row in db.execute(select(Sensor.id)).all()]


@router.get("/readings", response_model=list[ReadingOut])
def list_readings(
    db: Session = Depends(get_db),
    limit: int = Query(500, le=5000),
    sensor_id: Optional[str] = None,
    equipment_id: Optional[str] = None,
    anomalies_only: bool = False,
):
    stmt = select(Reading).order_by(desc(Reading.timestamp)).limit(limit)
    if sensor_id:
        stmt = stmt.where(Reading.sensor_id == sensor_id)
    if equipment_id:
        stmt = stmt.where(Reading.equipment_id == equipment_id)
    if anomalies_only:
        stmt = stmt.where(Reading.is_anomaly.is_(True))
    return db.execute(stmt).scalars().all()
