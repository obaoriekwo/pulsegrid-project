from datetime import datetime
from typing import Optional, List, Any
from pydantic import BaseModel, ConfigDict


class ReadingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sensor_id: str
    equipment_id: str
    timestamp: datetime
    voltage: float
    current: float
    temperature: float
    power: float
    humidity: float
    vibration: float
    ambient_temperature: Optional[float] = None
    ambient_humidity: Optional[float] = None
    external_factors: Optional[str] = None
    operational_status: Optional[str] = None
    labeled_fault_status: Optional[str] = None
    labeled_failure_type: Optional[str] = None
    anomaly_score: Optional[float] = None
    is_anomaly: bool
    predictive_maintenance_trigger: bool


class EquipmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    criticality: str
    relationship_type: str
    sensor_count: int = 0
    fault_count: int = 0
    pm_trigger_count: int = 0
    avg_temperature: Optional[float] = None
    avg_vibration: Optional[float] = None
    total_maintenance_cost: float = 0


class MaintenanceRecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    equipment_id: str
    date: datetime
    maintenance_type: str
    repair_time_hrs: float
    cost_usd: float
    failure_history: Optional[str] = None


class PipelineStage(BaseModel):
    stage: str
    status: str
    detail: str
    at: datetime


class PipelineRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    started_at: datetime
    finished_at: Optional[datetime] = None
    status: str
    readings_ingested: int
    readings_rejected: int
    anomalies_detected: int
    stage_log: List[Any] = []


class OverviewStats(BaseModel):
    sensor_count: int
    equipment_count: int
    total_readings: int
    anomaly_count: int
    anomaly_rate_pct: float
    pm_trigger_count: int
    avg_temperature: float
    avg_vibration: float
    downtime_hours_saved_estimate: Optional[float] = None
