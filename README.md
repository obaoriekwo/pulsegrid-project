# 📡 PulseGrid — Real-Time IoT Sensor & Predictive Maintenance Platform

A working IoT telemetry platform: a FastAPI backend ingests sensor readings, scores every one
of them with a trained **IsolationForest** anomaly-detection model, persists everything to
**PostgreSQL**, and streams live results to a dashboard over a **WebSocket**. The frontend is a
single dark-themed dashboard (vanilla JS + Chart.js) with five monitoring pages plus a page that
triggers the real ingestion pipeline on demand.

This project intentionally does **not** overclaim what it is. See [What's real vs. simulated](#whats-real-vs-simulated)
below — that section is part of the deliverable, not a disclaimer.

---

## Architecture

```
                     ┌────────────────────────────┐
   Sensor simulator  │   generate_synthetic_       │
   (stands in for    │   reading() — plausible     │
   real device        │  telemetry + occasional     │
   hardware)          │  injected fault spikes      │
                     └──────────────┬─────────────┘
                                    │
                                    ▼
                     ┌────────────────────────────┐
                     │   Ingestion Pipeline        │
                     │   1. Ingest                 │
                     │   2. Validate (range checks)│
                     │   3. Detect (IsolationForest│
                     │      scores every reading)  │
                     │   4. Publish (DB + WS push) │
                     └──────┬───────────────┬──────┘
                            │               │
                            ▼               ▼
                 ┌────────────────┐   ┌─────────────────┐
                 │  PostgreSQL     │   │  WebSocket       │
                 │  (readings,     │   │  /ws/live        │
                 │  equipment,     │   │  broadcasts each │
                 │  maintenance,   │   │  pipeline run    │
                 │  pipeline runs) │   └────────┬─────────┘
                 └────────┬────────┘            │
                          │                     ▼
                          │           ┌──────────────────┐
                          └──────────▶│  FastAPI REST API │
                                      │  /api/overview     │
                                      │  /api/sensors/...   │
                                      │  /api/equipment      │
                                      │  /api/anomalies       │
                                      │  /api/maintenance      │
                                      │  /api/pipeline/run      │
                                      └──────────┬───────────────┘
                                                 ▼
                                     ┌───────────────────────┐
                                     │  Dashboard (frontend/) │
                                     │  fetch() + WebSocket    │
                                     │  Chart.js visualizations │
                                     └───────────────────────┘
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, Uvicorn |
| Database | PostgreSQL, SQLAlchemy ORM |
| ML | scikit-learn `IsolationForest`, `StandardScaler` |
| Real-time | Native WebSockets (FastAPI) |
| Frontend | Vanilla JS, Chart.js 4, hand-written CSS |

## Project structure

```
pulsegrid/
├── app/
│   ├── main.py              FastAPI app, startup, background simulator loop
│   ├── config.py            Env-based settings
│   ├── database.py          SQLAlchemy engine/session
│   ├── models.py            ORM models (Equipment, Sensor, Reading, MaintenanceRecord, PipelineRun)
│   ├── schemas.py           Pydantic response models
│   ├── pipeline.py          The real ingest -> validate -> detect -> publish logic
│   ├── ws_manager.py        WebSocket connection manager
│   ├── ml_state.py          Shared loaded-model singleton
│   ├── ml/
│   │   └── anomaly_detector.py   IsolationForest train/load/score
│   └── routers/
│       ├── overview.py, sensors.py, equipment.py, anomalies.py, maintenance.py, pipeline_router.py
├── scripts/
│   └── seed_data.py         Loads the CSV into Postgres, trains the model
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/{data,charts,app}.js + vendor/chart.umd.js
├── sensor_maintenance_data.csv
├── requirements.txt
└── .env.example
```

## Setup

### 1. Prerequisites
- Python 3.11+
- PostgreSQL 14+ running locally (or update `DATABASE_URL` to point elsewhere)

### 2. Create the database
```bash
sudo -u postgres psql -c "CREATE USER pulsegrid WITH PASSWORD 'pulsegrid_dev_pw';"
sudo -u postgres psql -c "CREATE DATABASE pulsegrid OWNER pulsegrid;"
```

### 3. Install dependencies
```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # adjust DATABASE_URL if needed
```

### 4. Seed the database and train the model
```bash
python -m scripts.seed_data sensor_maintenance_data.csv
```
This loads the 500-reading historical CSV into Postgres and trains the IsolationForest on it.
Note: this particular sample CSV is a smooth synthetic ramp with no genuine outliers baked in, so
the model correctly finds ~0% anomalies in the historical data — real anomalies show up once the
live simulator starts injecting fault spikes (see below).

### 5. Run the server
```bash
uvicorn app.main:app --reload
```
Open **http://localhost:8000** — the dashboard is served directly by the API.

The background simulator starts automatically and generates a new batch of readings every
`SIMULATOR_INTERVAL_SECONDS` (default 2s), running the full real pipeline each time and pushing
the result to any connected dashboard over the WebSocket. You can also trigger a run manually from
the "Run Ingestion" page.

## API reference

| Endpoint | Description |
|---|---|
| `GET /api/overview` | Fleet-wide KPIs |
| `GET /api/sensors/readings` | Recent readings (filterable by sensor/equipment, anomalies-only) |
| `GET /api/equipment` | Equipment directory with aggregated stats |
| `GET /api/anomalies` | Model-flagged anomalous readings, most severe first |
| `GET /api/anomalies/failure-types` | Breakdown by historical failure label |
| `GET /api/maintenance` | Maintenance records |
| `POST /api/pipeline/run` | Manually trigger one ingest→validate→detect→publish cycle |
| `GET /api/pipeline/runs` | Pipeline run history |
| `WS /ws/live` | Live push, one message per pipeline run |

## What's real vs. simulated

Being upfront about this is more valuable for a portfolio than pretending otherwise:

- **Real:** the database, the ORM models, the ingestion/validation/publish pipeline code, the
  IsolationForest training and scoring, the WebSocket push, the REST API, and the dashboard's data
  fetching — all of this is genuine, working code with no mocked responses.
- **Simulated:** the sensor *hardware* itself. There's no physical device fleet, so
  `generate_synthetic_reading()` stands in for that, producing plausible telemetry and
  occasionally injecting a genuine out-of-range spike. The anomaly detector is never told which
  readings are spikes — it has to find them in the numbers, the same as it would with real
  hardware data. This is a standard, honest approach for an IoT portfolio project without access
  to a real sensor deployment.
- **Not claimed:** any measured "% reduction in downtime." That would require a real before/after
  deployment to measure, which doesn't exist here. The dashboard instead shows the actual live
  anomaly rate computed from the session's data.

## Future improvements
- Swap the synthetic simulator for a real MQTT broker (e.g. Mosquitto) if physical/virtual devices
  become available
- Add authentication for the API and dashboard
- Alerting (email/Slack) when the predictive-maintenance rule fires
- A/B the IsolationForest against a supervised model once real labeled failure data exists
