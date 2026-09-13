// ============================================================
// PulseGrid — data.js
// Talks to the real FastAPI backend (no more static CSV / mock
// data). All values shown in the dashboard come from these calls.
// ============================================================

const API_BASE = ""; // same-origin: FastAPI serves this frontend directly
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/live";

const Store = {
  overview: null,
  readings: [],
  equipment: [],
  anomalies: [],
  maintenance: [],
  failureTypes: {},
  pipelineRuns: [],
  ws: null,
  wsConnected: false,
  liveWave: [], // rolling buffer of recent metric values for the signal strip
};

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function apiPost(path) {
  const res = await fetch(API_BASE + path, { method: "POST" });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

const Api = {
  overview: () => apiGet("/api/overview"),
  readings: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiGet(`/api/sensors/readings${qs ? "?" + qs : ""}`);
  },
  equipment: () => apiGet("/api/equipment"),
  anomalies: (limit = 200) => apiGet(`/api/anomalies?limit=${limit}`),
  failureTypes: () => apiGet("/api/anomalies/failure-types"),
  maintenance: (limit = 3000) => apiGet(`/api/maintenance?limit=${limit}`),
  pipelineRuns: (limit = 20) => apiGet(`/api/pipeline/runs?limit=${limit}`),
  runPipeline: (n = 25) => apiPost(`/api/pipeline/run?n_readings=${n}`),
  health: () => apiGet("/api/health"),
};

/**
 * Pull everything the dashboard needs in one go. Used on initial load
 * and whenever the user hits Refresh.
 */
async function loadAll() {
  const [overview, readings, equipment, anomalies, failureTypes, maintenance, pipelineRuns] =
    await Promise.all([
      Api.overview(),
      Api.readings({ limit: 3000 }), // wider window so per-minute trend charts have enough time-spread to plot
      Api.equipment(),
      Api.anomalies(200),
      Api.failureTypes(),
      Api.maintenance(),
      Api.pipelineRuns(20),
    ]);
  Store.overview = overview;
  Store.readings = readings;
  Store.equipment = equipment;
  Store.anomalies = anomalies;
  Store.failureTypes = failureTypes;
  Store.maintenance = maintenance;
  Store.pipelineRuns = pipelineRuns;
  return Store;
}

/**
 * Open the live WebSocket. The backend pushes one message per pipeline
 * run — whether triggered by the background simulator (every couple of
 * seconds) or a manual "Run pipeline now" click — so this is genuinely
 * real-time, not a setInterval faking it on the client.
 */
function connectLiveSocket(onMessage) {
  try {
    const ws = new WebSocket(WS_URL);
    Store.ws = ws;
    ws.onopen = () => { Store.wsConnected = true; onMessage({ type: "conn", status: "open" }); };
    ws.onclose = () => {
      Store.wsConnected = false;
      onMessage({ type: "conn", status: "closed" });
      // basic reconnect backoff
      setTimeout(() => connectLiveSocket(onMessage), 3000);
    };
    ws.onerror = () => { Store.wsConnected = false; };
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        onMessage(data);
      } catch (e) { /* ignore malformed frame */ }
    };
  } catch (e) {
    onMessage({ type: "conn", status: "error" });
  }
}
