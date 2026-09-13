from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from sqlalchemy import select, desc

from app.database import get_db
from app.models import PipelineRun
from app.schemas import PipelineRunOut
from app.pipeline import run_pipeline
from app.ws_manager import manager
from app import ml_state

router = APIRouter(tags=["pipeline"])


@router.post("/api/pipeline/run", response_model=PipelineRunOut)
async def trigger_pipeline_run(n_readings: int = 25, db: Session = Depends(get_db)):
    run = run_pipeline(db, ml_state.detector, n_readings=n_readings, triggered_by="manual")
    await manager.broadcast({
        "type": "pipeline_run",
        "run_id": run.id,
        "status": run.status,
        "readings_ingested": run.readings_ingested,
        "anomalies_detected": run.anomalies_detected,
        "stage_log": run.stage_log,
    })
    return run


@router.get("/api/pipeline/runs", response_model=list[PipelineRunOut])
def list_pipeline_runs(db: Session = Depends(get_db), limit: int = 20):
    stmt = select(PipelineRun).order_by(desc(PipelineRun.id)).limit(limit)
    return db.execute(stmt).scalars().all()


@router.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't expect inbound messages, but keep the connection
            # alive and drain anything the client sends.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
