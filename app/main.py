import asyncio
import contextlib
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.database import SessionLocal, Base, engine
from app import ml_state
from app.config import settings
from app.pipeline import run_pipeline
from app.ws_manager import manager
from app.routers import overview, sensors, equipment, anomalies, maintenance, pipeline_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pulsegrid")

app = FastAPI(title="PulseGrid API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(overview.router)
app.include_router(sensors.router)
app.include_router(equipment.router)
app.include_router(anomalies.router)
app.include_router(maintenance.router)
app.include_router(pipeline_router.router)

_simulator_task: asyncio.Task | None = None


async def simulator_loop():
    """
    Background task standing in for real device telemetry: periodically
    runs the *same* ingest -> validate -> detect -> publish pipeline the
    manual "Run pipeline now" button triggers, and broadcasts the result
    to any connected dashboard over the WebSocket so the UI updates live.
    """
    while True:
        try:
            db = SessionLocal()
            try:
                run = run_pipeline(
                    db, ml_state.detector,
                    n_readings=settings.SIMULATOR_BATCH_SIZE,
                    triggered_by="simulator",
                )
                await manager.broadcast({
                    "type": "pipeline_run",
                    "run_id": run.id,
                    "status": run.status,
                    "readings_ingested": run.readings_ingested,
                    "anomalies_detected": run.anomalies_detected,
                    "stage_log": run.stage_log,
                })
            finally:
                db.close()
        except Exception:
            logger.exception("simulator_loop tick failed")
        await asyncio.sleep(settings.SIMULATOR_INTERVAL_SECONDS)


@app.on_event("startup")
async def on_startup():
    Base.metadata.create_all(bind=engine)
    try:
        ml_state.detector.load()
        logger.info("Loaded trained IsolationForest model from disk.")
    except FileNotFoundError:
        logger.warning(
            "No trained model found at %s - run `python -m scripts.seed_data "
            "sensor_maintenance_data.csv` first. The pipeline will skip "
            "anomaly detection until a model exists.",
            settings.MODEL_PATH,
        )

    global _simulator_task
    _simulator_task = asyncio.create_task(simulator_loop())


@app.on_event("shutdown")
async def on_shutdown():
    if _simulator_task:
        _simulator_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _simulator_task


@app.get("/api/health")
def health():
    return {"status": "ok", "model_loaded": ml_state.detector.is_ready()}


# Serve the dashboard frontend (index.html, css/, js/) from the same app.
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
