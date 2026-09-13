from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import select, desc, func

from app.database import get_db
from app.models import Reading
from app.schemas import ReadingOut

router = APIRouter(prefix="/api/anomalies", tags=["anomalies"])


@router.get("", response_model=list[ReadingOut])
def list_anomalies(db: Session = Depends(get_db), limit: int = Query(200, le=2000)):
    stmt = (
        select(Reading)
        .where(Reading.is_anomaly.is_(True))
        .order_by(Reading.anomaly_score.asc())  # most anomalous (most negative) first
        .limit(limit)
    )
    return db.execute(stmt).scalars().all()


@router.get("/failure-types")
def failure_type_breakdown(db: Session = Depends(get_db)):
    """
    Breakdown by the historical label where available (from the seeded CSV).
    Live-generated readings won't have a labeled_failure_type since there's
    no ground truth for them - only the model's is_anomaly verdict.
    """
    rows = db.execute(
        select(Reading.labeled_failure_type, func.count(Reading.id))
        .where(Reading.is_anomaly.is_(True))
        .group_by(Reading.labeled_failure_type)
    ).all()
    return {(label or "Unlabeled (live detection)"): count for label, count in rows}
