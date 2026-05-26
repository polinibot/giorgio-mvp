"""Test reali per database models - CRUD e relazioni."""

import pytest
from datetime import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database_sqlite import Base, Practice, PracticePhoto, PracticeSection, PracticePart, SystemSetting
from models import PracticeStatus, PracticeType, CustomerType, Context


@pytest.fixture
def db_session():
    """Crea database SQLite in memoria per test."""
    from sqlalchemy import event, text
    
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    
    # Abilita foreign keys per cascade delete tramite event listener
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
    
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


class TestPracticeCRUD:
    """Test CRUD reali per Practice."""

    def test_create_practice(self, db_session):
        """Test creazione pratica."""
        practice = Practice(
            created_by_telegram_id=123456,
            status=PracticeStatus.DRAFT,
            plate_confirmed="AB123CD",
            phone="+391234567890",
            customer_name="Test Cliente",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="10:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
        )
        db_session.add(practice)
        db_session.commit()
        db_session.refresh(practice)

        assert practice.id is not None
        assert practice.plate_confirmed == "AB123CD"
        assert practice.status == PracticeStatus.DRAFT

    def test_read_practice(self, db_session):
        """Test lettura pratica."""
        practice = Practice(
            created_by_telegram_id=123456,
            status=PracticeStatus.CONFIRMED,
            plate_confirmed="ZZ999YY",
            customer_name="Cliente Lettura",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 20),
            appointment_time="14:30",
            practice_type=PracticeType.ORDINE_DI_LAVORO,
            contexts="carrozzeria,revisione",
        )
        db_session.add(practice)
        db_session.commit()

        # Leggi dal DB
        found = db_session.query(Practice).filter(Practice.plate_confirmed == "ZZ999YY").first()
        assert found is not None
        assert found.customer_name == "Cliente Lettura"
        assert found.contexts_list == [Context.CARROZZERIA, Context.REVISIONE]

    def test_update_practice(self, db_session):
        """Test aggiornamento pratica."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="TEST99ZZ",
            customer_name="Nome Vecchio",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
        )
        db_session.add(practice)
        db_session.commit()

        # Aggiorna
        practice.customer_name = "Nome Nuovo"
        practice.status = PracticeStatus.CONFIRMED
        db_session.commit()

        # Verifica
        updated = db_session.query(Practice).filter(Practice.id == practice.id).first()
        assert updated.customer_name == "Nome Nuovo"
        assert updated.status == PracticeStatus.CONFIRMED

    def test_delete_practice(self, db_session):
        """Test soft delete pratica."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="DELETE01",
            customer_name="Da Cancellare",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
            status=PracticeStatus.CONFIRMED,
        )
        db_session.add(practice)
        db_session.commit()
        practice_id = practice.id

        # Soft delete (cambia status, non rimuove)
        practice.status = PracticeStatus.DELETED
        db_session.commit()

        # Verifica
        deleted = db_session.query(Practice).filter(Practice.id == practice_id).first()
        assert deleted.status == PracticeStatus.DELETED

    def test_practice_contexts_list_property(self, db_session):
        """Test property contexts_list."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="CONTEXT01",
            contexts="officina,carrozzeria,revisione",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
        )
        db_session.add(practice)
        db_session.commit()

        contexts = practice.contexts_list
        assert len(contexts) == 3
        assert Context.OFFICINA in contexts
        assert Context.CARROZZERIA in contexts
        assert Context.REVISIONE in contexts


class TestPracticeRelations:
    """Test relazioni tra Practice, Section, Part, Photo."""

    def test_practice_with_sections(self, db_session):
        """Test pratica con sezioni."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="SECTION01",
            customer_name="Test Sezioni",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
        )
        db_session.add(practice)
        db_session.commit()

        # Aggiungi sezioni
        section1 = PracticeSection(
            practice_id=practice.id,
            context=Context.OFFICINA,
            description_rows='["Tagliando", "Filtri"]',
            man_hours=2.5,
            mac_hours=None,
        )
        section2 = PracticeSection(
            practice_id=practice.id,
            context=Context.REVISIONE,
            description_rows='["Check luci"]',
            man_hours=0.5,
        )
        db_session.add_all([section1, section2])
        db_session.commit()

        # Verifica relazione
        sections = db_session.query(PracticeSection).filter(PracticeSection.practice_id == practice.id).all()
        assert len(sections) == 2
        assert sections[0].context == Context.OFFICINA

    def test_practice_with_parts(self, db_session):
        """Test pratica con pezzi."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="PARTS01",
            customer_name="Test Pezzi",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
        )
        db_session.add(practice)
        db_session.commit()

        # Aggiungi pezzi
        part1 = PracticePart(practice_id=practice.id, context=Context.OFFICINA, name="Olio 5W30", quantity="5 L")
        part2 = PracticePart(practice_id=practice.id, context=Context.OFFICINA, name="Filtro olio", quantity="1 pz")
        db_session.add_all([part1, part2])
        db_session.commit()

        # Verifica
        parts = db_session.query(PracticePart).filter(PracticePart.practice_id == practice.id).all()
        assert len(parts) == 2

    def test_cascade_delete_practice_removes_sections_and_parts(self, db_session):
        """Test che eliminando pratica si eliminano sezioni e pezzi (cascade)."""
        practice = Practice(
            created_by_telegram_id=123456,
            plate_confirmed="CASCADE01",
            customer_name="Test Cascade",
            customer_type=CustomerType.PRIVATO,
            appointment_date=datetime(2026, 11, 15),
            appointment_time="09:00",
            practice_type=PracticeType.PREVENTIVO,
            contexts="officina",
        )
        db_session.add(practice)
        db_session.commit()

        # Aggiungi sezione e pezzo
        section = PracticeSection(practice_id=practice.id, context=Context.OFFICINA, description_rows='["Test"]')
        part = PracticePart(practice_id=practice.id, context=Context.OFFICINA, name="Test Part")
        db_session.add_all([section, part])
        db_session.commit()

        practice_id = practice.id

        # Elimina pratica (hard delete per test cascade)
        db_session.delete(practice)
        db_session.commit()

        # Verifica che sezione e pezzo siano eliminati
        sections = db_session.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
        parts = db_session.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()
        assert len(sections) == 0
        assert len(parts) == 0


class TestSystemSetting:
    """Test SystemSetting per session YAP."""

    def test_create_and_read_setting(self, db_session):
        """Test creazione e lettura setting."""
        setting = SystemSetting(key="yap_session_state", value='{"cookies": {"test": "value"}}')
        db_session.add(setting)
        db_session.commit()

        found = db_session.query(SystemSetting).filter(SystemSetting.key == "yap_session_state").first()
        assert found is not None
        assert found.value == '{"cookies": {"test": "value"}}'

    def test_update_setting(self, db_session):
        """Test aggiornamento setting."""
        setting = SystemSetting(key="test_key", value="old_value")
        db_session.add(setting)
        db_session.commit()

        setting.value = "new_value"
        db_session.commit()

        found = db_session.query(SystemSetting).filter(SystemSetting.key == "test_key").first()
        assert found.value == "new_value"

    def test_delete_setting(self, db_session):
        """Test eliminazione setting."""
        setting = SystemSetting(key="delete_me", value="value")
        db_session.add(setting)
        db_session.commit()

        db_session.delete(setting)
        db_session.commit()

        found = db_session.query(SystemSetting).filter(SystemSetting.key == "delete_me").first()
        assert found is None
