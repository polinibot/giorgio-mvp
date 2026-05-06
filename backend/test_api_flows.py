import os
import tempfile
import unittest
from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database_sqlite import Base, Practice, PracticePart, PracticePhoto, PracticeSection
from main import app, get_db, require_whitelisted_user
from models import Context, CustomerType, PracticeStatus, PracticeType
from security import SecurityService


class ApiFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fd, cls.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        cls.engine = create_engine(
            f"sqlite:///{cls.db_path}",
            connect_args={"check_same_thread": False},
        )
        cls.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=cls.engine)
        Base.metadata.create_all(bind=cls.engine)

        cls.current_user = {"id": 761118078, "first_name": "Test", "last_name": "", "username": "tester"}

        def override_get_db():
            db = cls.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def override_user():
            return cls.current_user

        app.router.on_startup.clear()
        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[require_whitelisted_user] = override_user
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        cls.client.close()
        cls.engine.dispose()
        if os.path.exists(cls.db_path):
            os.remove(cls.db_path)

    def setUp(self):
        type(self).current_user = {"id": 761118078, "first_name": "Test", "last_name": "", "username": "tester"}
        with self.SessionLocal() as db:
            db.query(PracticePhoto).delete()
            db.query(PracticePart).delete()
            db.query(PracticeSection).delete()
            db.query(Practice).delete()
            db.commit()

    def seed_practice(
        self,
        *,
        practice_id,
        owner_id,
        status=PracticeStatus.CONFIRMED,
        plate="EG487YR",
        customer_name="Cliente Test",
        synced=False,
        contexts="officina",
    ):
        with self.SessionLocal() as db:
            practice = Practice(
                id=practice_id,
                created_by_telegram_id=owner_id,
                updated_by_telegram_id=owner_id,
                status=status,
                plate_confirmed=plate,
                phone="3331234567",
                customer_name=customer_name,
                customer_type=CustomerType.PRIVATO,
                billing_to_complete=False,
                appointment_date=datetime(2026, 6, 20, 9, 0, 0),
                appointment_time="09:00",
                practice_type=PracticeType.PREVENTIVO,
                contexts=contexts,
                internal_notes="nota",
                synced=synced,
            )
            db.add(practice)
            db.commit()
            return practice_id

    def seed_section_and_part(self, practice_id, context="officina"):
        with self.SessionLocal() as db:
            section = PracticeSection(
                practice_id=practice_id,
                context=Context(context),
                description_rows='["Tagliando completo"]',
                man_hours=1,
                mac_hours=None,
                materials_amount=None,
                waste_apply=False,
                waste_percentage=None,
                notes="OK",
            )
            part = PracticePart(
                practice_id=practice_id,
                context=Context(context),
                name="Filtro olio",
                quantity="1 pz",
            )
            db.add(section)
            db.add(part)
            db.commit()

    def build_full_payload(self, **practice_overrides):
        practice = {
            "plate_confirmed": "ZZ999YY",
            "phone": "3390001122",
            "customer_name": "Cliente Aggiornato",
            "customer_type": "privato",
            "billing_to_complete": False,
            "appointment_date": "2026-06-21T00:00:00",
            "appointment_time": "10:30",
            "practice_type": "preventivo",
            "contexts": ["officina", "revisione"],
            "internal_notes": "nota nuova",
        }
        practice.update(practice_overrides)

        return {
            "practice": practice,
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Diagnosi completa"],
                    "man_hours": 2,
                    "mac_hours": None,
                    "materials_amount": None,
                    "waste_apply": False,
                    "waste_percentage": None,
                    "notes": "Sezione 1",
                },
                {
                    "context": "revisione",
                    "description_rows": ["Pre-check revisione"],
                    "man_hours": None,
                    "mac_hours": None,
                    "materials_amount": None,
                    "waste_apply": False,
                    "waste_percentage": None,
                    "notes": "Sezione 2",
                },
            ],
            "parts": [
                {"context": "officina", "name": "Olio 5W30", "quantity": "4 L"},
            ],
        }

    def test_mini_app_bootstrap_without_practice_id_returns_user_payload(self):
        response = self.client.get("/mini-app/data", params={"user_id": self.current_user["id"]})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["user"]["id"], self.current_user["id"])

    def test_mini_app_data_repairs_owner_via_access_token(self):
        self.seed_practice(practice_id=1, owner_id=999, status=PracticeStatus.CONFIRMED)
        self.seed_section_and_part(1)
        token = SecurityService.generate_practice_access_token(1, self.current_user["id"])

        response = self.client.get(
            "/mini-app/data",
            params={"practice_id": 1, "user_id": self.current_user["id"], "access_token": token},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        with self.SessionLocal() as db:
            repaired = db.query(Practice).filter(Practice.id == 1).first()
            self.assertEqual(repaired.created_by_telegram_id, self.current_user["id"])

    def test_mini_app_data_repairs_draft_owner_via_plate_compat(self):
        self.seed_practice(practice_id=2, owner_id=555, status=PracticeStatus.DRAFT, plate="AA123BB")

        response = self.client.get(
            "/mini-app/data",
            params={"practice_id": 2, "user_id": self.current_user["id"], "plate_confirmed": "AA123BB"},
        )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            repaired = db.query(Practice).filter(Practice.id == 2).first()
            self.assertEqual(repaired.created_by_telegram_id, self.current_user["id"])

    def test_mini_app_data_rejects_wrong_plate_compat_when_owner_differs(self):
        self.seed_practice(practice_id=12, owner_id=555, status=PracticeStatus.DRAFT, plate="AA123BB")

        response = self.client.get(
            "/mini-app/data",
            params={"practice_id": 12, "user_id": self.current_user["id"], "plate_confirmed": "ZZ999YY"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Pratica non trovata")

    def test_dashboard_stats_and_filters_only_return_current_owner_data(self):
        self.seed_practice(practice_id=3, owner_id=self.current_user["id"], customer_name="Mario Rossi", contexts="officina", synced=False)
        self.seed_practice(practice_id=4, owner_id=self.current_user["id"], customer_name="Luca Bianchi", contexts="carrozzeria", synced=True)
        self.seed_practice(practice_id=5, owner_id=999, customer_name="Altro Utente", contexts="officina", synced=False)

        stats_response = self.client.get("/api/practices/stats", params={"user_id": self.current_user["id"]})
        self.assertEqual(stats_response.status_code, 200)
        stats = stats_response.json()["data"]
        self.assertEqual(stats["total"], 2)
        self.assertEqual(stats["pending_sync"], 1)

        filtered = self.client.get(
            "/api/practices",
            params={"user_id": self.current_user["id"], "context": "carrozzeria", "synced": "true"},
        )
        self.assertEqual(filtered.status_code, 200)
        items = filtered.json()["data"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["customer_name"], "Luca Bianchi")

    def test_create_full_persists_owner_sections_and_parts(self):
        payload = self.build_full_payload(
            plate_confirmed="FF321GG",
            customer_name="Nuovo Cliente",
            contexts=["officina", "carrozzeria"],
        )
        payload["sections"][1]["context"] = "carrozzeria"
        payload["sections"][1]["description_rows"] = ["Ripristino paraurti"]

        response = self.client.post(
            "/practices/full",
            params={"user_id": self.current_user["id"]},
            json=payload,
        )

        self.assertEqual(response.status_code, 200)
        created_id = response.json()["data"]["id"]
        with self.SessionLocal() as db:
            practice = db.query(Practice).filter(Practice.id == created_id).first()
            sections = db.query(PracticeSection).filter(PracticeSection.practice_id == created_id).all()
            parts = db.query(PracticePart).filter(PracticePart.practice_id == created_id).all()

            self.assertEqual(practice.created_by_telegram_id, self.current_user["id"])
            self.assertEqual(practice.contexts, "officina,carrozzeria")
            self.assertEqual(practice.customer_name, "Nuovo Cliente")
            self.assertEqual(len(sections), 2)
            self.assertEqual(len(parts), 1)

    def test_update_full_replaces_sections_and_parts_for_existing_practice(self):
        self.seed_practice(practice_id=6, owner_id=self.current_user["id"], contexts="officina")
        self.seed_section_and_part(6)

        payload = self.build_full_payload()

        response = self.client.put(
            "/practices/6/full",
            params={"user_id": self.current_user["id"]},
            json=payload,
        )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            practice = db.query(Practice).filter(Practice.id == 6).first()
            sections = db.query(PracticeSection).filter(PracticeSection.practice_id == 6).all()
            parts = db.query(PracticePart).filter(PracticePart.practice_id == 6).all()

            self.assertEqual(practice.plate_confirmed, "ZZ999YY")
            self.assertEqual(practice.contexts, "officina,revisione")
            self.assertEqual(len(sections), 2)
            self.assertEqual(len(parts), 1)
            self.assertEqual(parts[0].name, "Olio 5W30")

    def test_update_full_denies_wrong_user_without_access_token(self):
        self.seed_practice(practice_id=13, owner_id=999, contexts="officina")

        response = self.client.put(
            "/practices/13/full",
            params={"user_id": self.current_user["id"]},
            json=self.build_full_payload(),
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Pratica non trovata")

    def test_sync_toggle_repairs_owner_via_access_token(self):
        self.seed_practice(practice_id=8, owner_id=999, synced=False)
        token = SecurityService.generate_practice_access_token(8, self.current_user["id"])

        response = self.client.patch(
            "/api/practices/8/sync",
            params={"user_id": self.current_user["id"], "access_token": token},
            json={"synced": True},
        )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            practice = db.query(Practice).filter(Practice.id == 8).first()
            self.assertTrue(practice.synced)
            self.assertEqual(practice.created_by_telegram_id, self.current_user["id"])

    def test_delete_soft_deletes_and_repairs_owner_via_access_token(self):
        self.seed_practice(practice_id=9, owner_id=999, status=PracticeStatus.CONFIRMED)
        token = SecurityService.generate_practice_access_token(9, self.current_user["id"])

        response = self.client.delete(
            "/practices/9",
            params={"user_id": self.current_user["id"], "access_token": token},
        )

        self.assertEqual(response.status_code, 200)
        with self.SessionLocal() as db:
            practice = db.query(Practice).filter(Practice.id == 9).first()
            self.assertEqual(practice.status, PracticeStatus.DELETED)
            self.assertEqual(practice.created_by_telegram_id, self.current_user["id"])

    def test_practice_detail_denies_wrong_user_without_access_token(self):
        self.seed_practice(practice_id=7, owner_id=999, status=PracticeStatus.CONFIRMED)

        response = self.client.get("/api/practices/7", params={"user_id": self.current_user["id"]})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Pratica non trovata")


if __name__ == "__main__":
    unittest.main()
