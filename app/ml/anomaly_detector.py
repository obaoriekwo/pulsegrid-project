"""
Real anomaly detection for PulseGrid.

Trains a scikit-learn IsolationForest on sensor telemetry (voltage, current,
temperature, power, humidity, vibration, ambient temperature/humidity) and
uses it to score every new reading that comes through the ingestion
pipeline. This replaces the pre-baked "Fault Detected" / "Predictive
Maintenance Trigger" columns that existed as static labels in the original
CSV - here, both are *computed* from the model's output.
"""
import os
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

FEATURE_COLUMNS = [
    "voltage", "current", "temperature", "power",
    "humidity", "vibration", "ambient_temperature", "ambient_humidity",
]


class AnomalyDetector:
    def __init__(self, model_path: str, scaler_path: str, contamination: float = 0.08):
        self.model_path = model_path
        self.scaler_path = scaler_path
        self.contamination = contamination
        self.model: IsolationForest | None = None
        self.scaler: StandardScaler | None = None

    def train(self, df: pd.DataFrame) -> dict:
        """Fit the scaler + isolation forest on a dataframe of historical readings."""
        X = df[FEATURE_COLUMNS].astype(float).values
        self.scaler = StandardScaler()
        X_scaled = self.scaler.fit_transform(X)

        self.model = IsolationForest(
            n_estimators=200,
            contamination=self.contamination,
            random_state=42,
        )
        self.model.fit(X_scaled)

        os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
        joblib.dump(self.model, self.model_path)
        joblib.dump(self.scaler, self.scaler_path)

        scores = self.model.decision_function(X_scaled)
        preds = self.model.predict(X_scaled)  # -1 = anomaly, 1 = normal
        return {
            "n_samples": len(df),
            "n_flagged": int((preds == -1).sum()),
            "score_min": float(scores.min()),
            "score_max": float(scores.max()),
        }

    def load(self):
        self.model = joblib.load(self.model_path)
        self.scaler = joblib.load(self.scaler_path)

    def is_ready(self) -> bool:
        return self.model is not None and self.scaler is not None

    def score_one(self, features: dict) -> tuple[float, bool]:
        """
        Score a single reading. Returns (anomaly_score, is_anomaly).
        anomaly_score: higher = more normal, lower (more negative) = more anomalous
        (this is IsolationForest's native decision_function convention).
        """
        if not self.is_ready():
            raise RuntimeError("AnomalyDetector model not loaded/trained yet")

        x = np.array([[features[col] for col in FEATURE_COLUMNS]], dtype=float)
        x_scaled = self.scaler.transform(x)
        score = float(self.model.decision_function(x_scaled)[0])
        pred = int(self.model.predict(x_scaled)[0])  # -1 anomaly, 1 normal
        return score, pred == -1

    def score_batch(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        if not self.is_ready():
            raise RuntimeError("AnomalyDetector model not loaded/trained yet")
        X = df[FEATURE_COLUMNS].astype(float).values
        X_scaled = self.scaler.transform(X)
        scores = self.model.decision_function(X_scaled)
        preds = self.model.predict(X_scaled)
        return scores, preds == -1
