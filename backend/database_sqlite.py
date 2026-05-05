import logging
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, Float, Enum, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

from models import PracticeStatus, PracticeType, CustomerType, Context

logger = logging.getLogger(__name__)

# Database SQLite - niente Docker richiesto
DATABASE_URL = "sqlite:///./giorgio.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}  # Necessario per SQLite
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


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
    # SQLite non supporta array, usiamo stringa separata da virgole
    contexts = Column(String(100), nullable=False)  # "officina,carrozzeria"
    internal_notes = Column(Text, nullable=True)
    management_external_id = Column(String(100), nullable=True)
    management_sync_status = Column(String(50), nullable=True)
    management_last_sync_at = Column(DateTime, nullable=True)
    synced = Column(Boolean, default=False, nullable=False)

    @property
    def contexts_list(self):
        """Converte stringa contexts in lista"""
        if self.contexts:
            return [Context(c.strip()) for c in self.contexts.split(',') if c.strip()]
        return []

    @contexts_list.setter
    def contexts_list(self, contexts_list):
        """Converte lista in stringa contexts"""
        if contexts_list:
            self.contexts = ','.join([c.value if isinstance(c, Context) else c for c in contexts_list])
        else:
            self.contexts = ""


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
    # SQLite non supporta array, usiamo JSON string
    description_rows = Column(Text, nullable=False)  # JSON string
    man_hours = Column(Float, nullable=True)
    mac_hours = Column(Float, nullable=True)
    materials_amount = Column(Float, nullable=True)
    waste_apply = Column(Boolean, nullable=True)
    waste_percentage = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)

    @property
    def description_rows_list(self):
        """Converte JSON string in lista"""
        import json
        if self.description_rows:
            try:
                return json.loads(self.description_rows)
            except Exception:
                return [self.description_rows]
        return []

    @description_rows_list.setter
    def description_rows_list(self, rows_list):
        """Converte lista in JSON string"""
        import json
        self.description_rows = json.dumps(rows_list)


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


def create_tables():
    """Crea tutte le tabelle del database"""
    Base.metadata.create_all(bind=engine)
    # Migrate: add notes column to practice_sections if missing
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT notes FROM practice_sections LIMIT 1"))
    except Exception:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE practice_sections ADD COLUMN notes TEXT"))
            conn.commit()
        logger.info("Migrated: added notes column to practice_sections")
    logger.info("Database SQLite creato con successo")


if __name__ == "__main__":
    create_tables()
