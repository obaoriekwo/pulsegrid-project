from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, desc

from app.database import get_db
from app.models import MaintenanceRecord
from app.schemas import MaintenanceRecordOut

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


@router.get("", response_model=list[MaintenanceRecordOut])
def list_maintenance(db: Session = Depends(get_db), limit: int = Query(500, le=5000)):
    stmt = select(MaintenanceRecord).order_by(desc(MaintenanceRecord.date)).limit(limit)
    return db.execute(stmt).scalars().all()
