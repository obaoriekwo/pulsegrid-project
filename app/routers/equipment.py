from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from app.database import get_db
from app.models import Equipment, Sensor, Reading, MaintenanceRecord
from app.schemas import EquipmentOut

router = APIRouter(prefix="/api/equipment", tags=["equipment"])


@router.get("", response_model=list[EquipmentOut])
def list_equipment(db: Session = Depends(get_db)):
    equipment = db.execute(select(Equipment)).scalars().all()
    out = []
    for eq in equipment:
        sensor_count = db.scalar(
            select(func.count(Sensor.id)).where(Sensor.equipment_id == eq.id)
        ) or 0
        fault_count = db.scalar(
            select(func.count(Reading.id)).where(
                Reading.equipment_id == eq.id, Reading.is_anomaly.is_(True)
            )
        ) or 0
        pm_count = db.scalar(
            select(func.count(Reading.id)).where(
                Reading.equipment_id == eq.id,
                Reading.predictive_maintenance_trigger.is_(True),
            )
        ) or 0
        avg_temp = db.scalar(
            select(func.avg(Reading.temperature)).where(Reading.equipment_id == eq.id)
        )
        avg_vib = db.scalar(
            select(func.avg(Reading.vibration)).where(Reading.equipment_id == eq.id)
        )
        total_cost = db.scalar(
            select(func.coalesce(func.sum(MaintenanceRecord.cost_usd), 0.0)).where(
                MaintenanceRecord.equipment_id == eq.id
            )
        ) or 0.0

        out.append(EquipmentOut(
            id=eq.id,
            criticality=eq.criticality,
            relationship_type=eq.relationship_type,
            sensor_count=sensor_count,
            fault_count=fault_count,
            pm_trigger_count=pm_count,
            avg_temperature=round(float(avg_temp), 2) if avg_temp is not None else None,
            avg_vibration=round(float(avg_vib), 3) if avg_vib is not None else None,
            total_maintenance_cost=round(float(total_cost), 2),
        ))
    out.sort(key=lambda e: e.fault_count, reverse=True)
    return out
