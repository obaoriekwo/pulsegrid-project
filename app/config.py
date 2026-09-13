import os

class Settings:
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://pulsegrid:pulsegrid_dev_pw@localhost:5432/pulsegrid",
    )
    # How often the simulator generates a new batch of readings, in seconds
    SIMULATOR_INTERVAL_SECONDS: float = float(os.getenv("SIMULATOR_INTERVAL_SECONDS", "2.0"))
    # Number of sensors simulated per tick (rotates through the fleet)
    SIMULATOR_BATCH_SIZE: int = int(os.getenv("SIMULATOR_BATCH_SIZE", "25"))
    MODEL_PATH: str = os.getenv("MODEL_PATH", "app/ml/isolation_forest.joblib")
    SCALER_PATH: str = os.getenv("SCALER_PATH", "app/ml/scaler.joblib")

settings = Settings()
