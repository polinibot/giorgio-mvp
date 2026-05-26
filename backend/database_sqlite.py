import logging
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, Boolean, Float, Enum, text, ForeignKey, Index
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime

from config import settings
from models import PracticeStatus, PracticeType, CustomerType, Context

logger = logging.getLogger(__name__)

DATABASE_URL = settings.database_url or "sqlite:///./giorgio.db"

engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    engine_kwargs.update(pool_size=10, pool_recycle=3600, pool_pre_ping=True)

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Practice(Base):
    __tablename__ = "practices"
    __table_args__ = (
        Index("ix_practices_owner_status_created", "created_by_telegram_id", "status", "created_at"),
        Index("ix_practices_owner_status_synced", "created_by_telegram_id", "status", "synced"),
    )

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_telegram_id = Column(Integer, nullable=False, index=True)
    updated_by_telegram_id = Column(Integer, nullable=True)
    status = Column(Enum(PracticeStatus, values_callable=enum_values), default=PracticeStatus.DRAFT)
    plate_detected = Column(String(20), nullable=True)
    plate_confirmed = Column(String(20), nullable=True)
    phone = Column(String(20), nullable=True)
    customer_name = Column(String(200), nullable=True)
    customer_type = Column(Enum(CustomerType, values_callable=enum_values), nullable=False)
    billing_to_complete = Column(Boolean, default=False)
    appointment_date = Column(DateTime, nullable=False)
    appointment_time = Column(String(5), nullable=False)  # HH:MM
    practice_type = Column(Enum(PracticeType, values_callable=enum_values), nullable=False)
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
    __table_args__ = (
        Index("ix_practice_photos_practice_created", "practice_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, ForeignKey("practices.id", ondelete="CASCADE"), nullable=False, index=True)
    telegram_file_id = Column(String(500), nullable=False)
    storage_path = Column(String(500), nullable=False)
    ocr_result = Column(String(20), nullable=True)
    ocr_confidence = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PracticeSection(Base):
    __tablename__ = "practice_sections"
    __table_args__ = (
        Index("ix_practice_sections_practice_context", "practice_id", "context"),
    )

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, ForeignKey("practices.id", ondelete="CASCADE"), nullable=False, index=True)
    context = Column(Enum(Context, values_callable=enum_values), nullable=False)
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
    __table_args__ = (
        Index("ix_practice_parts_practice_context", "practice_id", "context"),
    )

    id = Column(Integer, primary_key=True, index=True)
    practice_id = Column(Integer, ForeignKey("practices.id", ondelete="CASCADE"), nullable=False, index=True)
    context = Column(Enum(Context, values_callable=enum_values), nullable=False)
    name = Column(String(200), nullable=False)
    quantity = Column(String(50), nullable=True)  # Testuale: "1 pz", "2 pz", "3,5 kg"


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True, index=True)
    value = Column(Text, nullable=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    """Crea tutte le tabelle del database"""
    Base.metadata.create_all(bind=engine)
    if DATABASE_URL.startswith("sqlite"):
        with engine.connect() as conn:
            conn.execute(text("UPDATE practices SET status = lower(status) WHERE status IN ('DRAFT', 'CONFIRMED', 'DELETED', 'SYNC_PENDING', 'SYNCED', 'SYNC_FAILED')"))
            conn.execute(text("UPDATE practices SET customer_type = lower(customer_type) WHERE customer_type IN ('PRIVATO', 'AZIENDA')"))
            conn.execute(text("UPDATE practices SET practice_type = lower(practice_type) WHERE practice_type IN ('PREVENTIVO', 'ORDINE_DI_LAVORO')"))
            conn.execute(text("UPDATE practice_sections SET context = lower(context) WHERE context IN ('OFFICINA', 'CARROZZERIA', 'REVISIONE')"))
            conn.execute(text("UPDATE practice_parts SET context = lower(context) WHERE context IN ('OFFICINA', 'CARROZZERIA', 'REVISIONE')"))
            conn.commit()
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT synced FROM practices LIMIT 1"))
    except Exception:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE practices ADD COLUMN synced BOOLEAN DEFAULT FALSE NOT NULL"))
            conn.commit()
        logger.info("Migrated: added synced column to practices")
    # Migrate: add notes column to practice_sections if missing
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT notes FROM practice_sections LIMIT 1"))
    except Exception:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE practice_sections ADD COLUMN notes TEXT"))
            conn.commit()
        logger.info("Migrated: added notes column to practice_sections")
    # Migrate: make plate_confirmed, phone, customer_name nullable
    try:
        if DATABASE_URL.startswith("sqlite"):
            with engine.connect() as conn:
                pragma_rows = conn.execute(text("PRAGMA table_info(practices)")).fetchall()
                notnull_by_column = {row[1]: row[3] for row in pragma_rows}  # row[1]=name, row[3]=notnull
                needs_nullable_migration = any(
                    notnull_by_column.get(column_name, 0) == 1
                    for column_name in ("plate_confirmed", "phone", "customer_name")
                )

                if needs_nullable_migration:
                    conn.execute(text("DROP TABLE IF EXISTS practices_new"))
                    conn.execute(text("""
                        CREATE TABLE practices_new (
                            id INTEGER PRIMARY KEY,
                            created_at DATETIME,
                            updated_at DATETIME,
                            created_by_telegram_id INTEGER NOT NULL,
                            updated_by_telegram_id INTEGER,
                            status VARCHAR,
                            plate_detected VARCHAR(20),
                            plate_confirmed VARCHAR(20),
                            phone VARCHAR(20),
                            customer_name VARCHAR(200),
                            customer_type VARCHAR,
                            billing_to_complete BOOLEAN DEFAULT 0,
                            appointment_date DATETIME NOT NULL,
                            appointment_time VARCHAR(5) NOT NULL,
                            practice_type VARCHAR,
                            contexts VARCHAR(100) NOT NULL,
                            internal_notes TEXT,
                            management_external_id VARCHAR(100),
                            management_sync_status VARCHAR(50),
                            management_last_sync_at DATETIME,
                            synced BOOLEAN DEFAULT 0 NOT NULL
                        )
                    """))
                    conn.execute(text("""
                        INSERT INTO practices_new (
                            id,
                            created_at,
                            updated_at,
                            created_by_telegram_id,
                            updated_by_telegram_id,
                            status,
                            plate_detected,
                            plate_confirmed,
                            phone,
                            customer_name,
                            customer_type,
                            billing_to_complete,
                            appointment_date,
                            appointment_time,
                            practice_type,
                            contexts,
                            internal_notes,
                            management_external_id,
                            management_sync_status,
                            management_last_sync_at,
                            synced
                        )
                        SELECT
                            id,
                            created_at,
                            updated_at,
                            created_by_telegram_id,
                            updated_by_telegram_id,
                            status,
                            plate_detected,
                            plate_confirmed,
                            phone,
                            customer_name,
                            customer_type,
                            billing_to_complete,
                            appointment_date,
                            appointment_time,
                            practice_type,
                            contexts,
                            internal_notes,
                            management_external_id,
                            management_sync_status,
                            management_last_sync_at,
                            synced
                        FROM practices
                    """))
                    conn.execute(text("DROP TABLE practices"))
                    conn.execute(text("ALTER TABLE practices_new RENAME TO practices"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practices_id ON practices (id)"))
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practices_created_by_telegram_id ON practices (created_by_telegram_id)"))
                    conn.commit()
                    logger.info("Migrated SQLite: made plate_confirmed, phone, customer_name nullable")
        elif "postgresql" in DATABASE_URL:
            with engine.connect() as conn:
                res = conn.execute(text("""
                    SELECT column_name, is_nullable 
                    FROM information_schema.columns 
                    WHERE table_name = 'practices' AND column_name IN ('plate_confirmed', 'phone', 'customer_name')
                """)).fetchall()
                notnull_cols = [row[0] for row in res if row[1] == 'NO']
                if notnull_cols:
                    for column_name in notnull_cols:
                        conn.execute(text(f"ALTER TABLE practices ALTER COLUMN {column_name} DROP NOT NULL"))
                    conn.commit()
                    logger.info("Migrated Postgres: made columns %s nullable", notnull_cols)
    except Exception as e:
        logger.warning("Migration to nullable columns failed (may already exist): %s", e)

    try:
        with engine.connect() as conn:
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practices_owner_status_created ON practices (created_by_telegram_id, status, created_at)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practices_owner_status_synced ON practices (created_by_telegram_id, status, synced)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practice_sections_practice_context ON practice_sections (practice_id, context)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practice_parts_practice_context ON practice_parts (practice_id, context)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_practice_photos_practice_created ON practice_photos (practice_id, created_at)"))
            conn.commit()
    except Exception as e:
        logger.warning("Index optimization migration failed (may already exist): %s", e)

    logger.info("Database SQLite creato con successo")


if __name__ == "__main__":
    create_tables()
