import logging
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, Float, ARRAY, Enum
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

from config import settings
from models import PracticeStatus, PracticeType, CustomerType, Context

logger = logging.getLogger(__name__)

# Pool configuration for PostgreSQL; SQLite ignores pool_size/pool_recycle
engine_kwargs = {}
if settings.database_url and not settings.database_url.startswith("sqlite"):
    engine_kwargs.update(
        pool_size=10,
        pool_recycle=3600,
        pool_pre_ping=True,
    )

engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

logger.info("Database engine created with URL: %s", settings.database_url[:20] + "...")


class Practice(Base):
    __tablename__ = "practices"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_telegram_id = Column(Integer, nullable=False, index=True)
    updated_by_telegram_id = Column(Integer, nullable=True)
    status = Column(Enum(PracticeStatus), default=PracticeStatus.DRAFT)
    plate_detected = Column(String(20), nullable=True)
    plate_confirmed = Column(String(20), nullable=False)
    phone = Column(String(20), nullable=False)
    customer_name = Column(String(200), nullable=False)
    customer_type = Column(Enum(CustomerType), nullable=False)
    billing_to_complete = Column(Boolean, default=False)
    appointment_date = Column(DateTime, nullable=False)
    appointment_time = Column(String(5), nullable=False)  # HH:MM
    practice_type = Column(Enum(PracticeType), nullable=False)
    contexts = Column(ARRAY(Enum(Context)), nullable=False)
    internal_notes = Column(Text, nullable=True)
    management_external_id = Column(String(100), nullable=True)
    management_sync_status = Column(String(50), nullable=True)
    management_last_sync_at = Column(DateTime, nullable=True)


class PracticePhoto(Base):
    __tablename__ = "practice_photos"

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, nullable=False, index=True)
    telegram_file_id = Column(String(500), nullable=False)
    storage_path = Column(String(500), nullable=False)
    ocr_result = Column(String(20), nullable=True)
    ocr_confidence = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PracticeSection(Base):
    __tablename__ = "practice_sections"

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, nullable=False, index=True)
    context = Column(Enum(Context), nullable=False)
    description_rows = Column(ARRAY(Text), nullable=False)
    man_hours = Column(Float, nullable=True)
    mac_hours = Column(Float, nullable=True)
    materials_amount = Column(Float, nullable=True)
    waste_apply = Column(Boolean, nullable=True)
    waste_percentage = Column(Float, nullable=True)


class PracticePart(Base):
    __tablename__ = "practice_parts"

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, nullable=False, index=True)
    context = Column(Enum(Context), nullable=False)
    name = Column(String(200), nullable=False)
    quantity = Column(String(50), nullable=True)  # Testuale: "1 pz", "2 pz", "3,5 kg"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
