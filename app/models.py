from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, ForeignKey, JSON
)
from sqlalchemy.orm import relationship
from datetime import datetime

from app.database import Base


class Equipment(Base):
    __tablename__ = "equipment"

    id = Column(String, primary_key=True)  # e.g. "E_1"
    criticality = Column(String, default="Medium")  # Low / Medium / High
    relationship_type = Column(String, default="Independent")  # Independent / Dependent
    x = Column(Float, default=0)
    y = Column(Float, default=0)
    z = Column(Float, default=0)

    sensors = relationship("Sensor", back_populates="equipment")
    maintenance_records = relationship("MaintenanceRecord", back_populates="equipment")


class Sensor(Base):
    __tablename__ = "sensors"

    id = Column(String, primary_key=True)  # e.g. "S_1"
    equipment_id = Column(String, ForeignKey("equipment.id"))

    equipment = relationship("Equipment", back_populates="sensors")
    readings = relationship("Reading", back_populates="sensor")


class Reading(Base):
    __tablename__ = "readings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sensor_id = Column(String, ForeignKey("sensors.id"), index=True)
    equipment_id = Column(String, ForeignKey("equipment.id"), index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

    voltage = Column(Float)
    current = Column(Float)
    temperature = Column(Float)
    power = Column(Float)
    humidity = Column(Float)
    vibration = Column(Float)

    ambient_temperature = Column(Float)
    ambient_humidity = Column(Float)
    external_factors = Column(String)

    operational_status = Column(String)  # Operational / Under Maintenance

    # Ground-truth labels carried over from the seed dataset (nullable for
    # readings generated live by the simulator, which have none).
    labeled_fault_status = Column(String, nullable=True)
    labeled_failure_type = Column(String, nullable=True)

    # Fields computed by our own pipeline (never hand-set from a CSV label)
    anomaly_score = Column(Float, nullable=True)   # raw isolation forest score
    is_anomaly = Column(Boolean, default=False, index=True)
    predictive_maintenance_trigger = Column(Boolean, default=False)

    sensor = relationship("Sensor", back_populates="readings")


class MaintenanceRecord(Base):
    __tablename__ = "maintenance_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    equipment_id = Column(String, ForeignKey("equipment.id"), index=True)
    date = Column(DateTime)
    maintenance_type = Column(String)  # Preventive / Corrective
    repair_time_hrs = Column(Float, default=0)
    cost_usd = Column(Float, default=0)
    failure_history = Column(String, nullable=True)

    equipment = relationship("Equipment", back_populates="maintenance_records")


class PipelineRun(Base):
    """
    Records one execution of the real ingestion pipeline
    (ingest -> validate -> detect -> publish), triggered either by the
    background simulator or a manual "Run pipeline now" API call.
    """
    __tablename__ = "pipeline_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    status = Column(String, default="running")  # running / success / failed
    readings_ingested = Column(Integer, default=0)
    readings_rejected = Column(Integer, default=0)
    anomalies_detected = Column(Integer, default=0)
    stage_log = Column(JSON, default=list)  # list of {stage, status, detail, at}
