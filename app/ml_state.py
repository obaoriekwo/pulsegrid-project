from app.ml.anomaly_detector import AnomalyDetector
from app.config import settings

detector = AnomalyDetector(settings.MODEL_PATH, settings.SCALER_PATH)
