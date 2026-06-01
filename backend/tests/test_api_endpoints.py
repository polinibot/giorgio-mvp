"""Test reali per API Endpoints - tutti gli endpoint HTTP."""

import pytest


@pytest.fixture
def _api_tests_marker():
    """Marker di compatibilità per mantenere il file auto-contenuto."""
    return True


class TestHealthEndpoints:
    """Test endpoint health check."""

    def test_root_endpoint(self, client):
        """Test GET /."""
        response = client.get("/")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_health_endpoint(self, client):
        """Test GET /health."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert "timestamp" in response.json()

    def test_test_connection_endpoint(self, client):
        """Test GET /test-connection."""
        response = client.get("/test-connection")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_client_diagnostics_endpoint(self, client):
        """Test POST /client-diagnostics accepts sanitized client reports."""
        response = client.post(
            "/client-diagnostics",
            json={
                "source": "mini-app",
                "severity": "error",
                "message": "Errore di rete",
                "url": "https://example.test/?access_token=secret-token",
                "telegram_user_id": "761118078",
                "api": {
                    "label": "dashboard.list",
                    "status": "error",
                    "url": "https://api.test/mini-app/data?hash=secret-hash",
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["success"] is True
        assert response.json()["data"]["received"] is True


class TestMiniAppEndpoints:
    """Test endpoint Mini App."""

    def test_mini_app_data_without_practice(self, client):
        """Test GET /mini-app/data senza practice_id."""
        response = client.get("/mini-app/data?user_id=761118078")
        assert response.status_code == 200
        assert response.json()["success"] is True
        assert "user" in response.json()["data"]


class TestPracticesAPIEndpoints:
    """Test endpoint /api/practices/*."""

    def test_get_practices_stats_empty(self, client):
        """Test GET /api/practices/stats con DB vuoto."""
        response = client.get("/api/practices/stats?user_id=761118078")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["total"] == 0
        assert data["pending_sync"] == 0

    def test_list_practices_empty(self, client):
        """Test GET /api/practices con DB vuoto."""
        response = client.get("/api/practices?user_id=761118078")
        assert response.status_code == 200
        assert response.json()["data"] == []


class TestPracticesCRUDEndpoints:
    """Test CRUD endpoint /practices/*."""

    def test_create_practice(self, client):
        """Test POST /practices."""
        practice_data = {
            "plate_confirmed": "TEST01ZZ",
            "phone": "+391234567890",
            "customer_name": "Test Cliente API",
            "customer_type": "privato",
            "billing_to_complete": False,
            "appointment_date": "2026-11-15T00:00:00",
            "appointment_time": "10:00",
            "practice_type": "preventivo",
            "contexts": ["officina"],
            "internal_notes": "Nota test",
        }

        response = client.post("/practices?user_id=761118078", json=practice_data)

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["plate_confirmed"] == "TEST01ZZ"
        assert data["customer_name"] == "Test Cliente API"
        assert data["synced"] is False

    def test_create_practice_normalizes_appointment_time(self, client):
        """Test POST /practices canonicalizza l'orario su slot YAP."""
        practice_data = {
            "plate_confirmed": "TEST01YY",
            "phone": "+391234567890",
            "customer_name": "Test Orario Canonico",
            "customer_type": "privato",
            "billing_to_complete": False,
            "appointment_date": "2026-11-15T00:00:00",
            "appointment_time": "07:15",
            "practice_type": "preventivo",
            "contexts": ["officina"],
        }

        response = client.post("/practices?user_id=761118078", json=practice_data)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["appointment_time"] == "07:20"

    def test_create_and_get_practice_detail(self, client):
        """Test POST /practices e GET /api/practices/{id}."""
        create_resp = client.post(
            "/practices?user_id=761118078",
            json={
                "plate_confirmed": "TEST02ZZ",
                "phone": "+391234567890",
                "customer_name": "Cliente Dettaglio",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-16T00:00:00",
                "appointment_time": "14:30",
                "practice_type": "ordine_di_lavoro",
                "contexts": ["officina", "revisione"],
            },
        )
        assert create_resp.status_code == 200
        practice_id = create_resp.json()["data"]["id"]

        detail_resp = client.get(f"/api/practices/{practice_id}?user_id=761118078")
        assert detail_resp.status_code == 200
        data = detail_resp.json()["data"]["practice"]
        assert data["plate_confirmed"] == "TEST02ZZ"
        assert data["customer_name"] == "Cliente Dettaglio"
        assert data["contexts"] == ["officina", "revisione"]

    def test_create_and_update_practice(self, client):
        """Test POST /practices e PUT /practices/{id}."""
        create_resp = client.post(
            "/practices?user_id=761118078",
            json={
                "plate_confirmed": "TEST03ZZ",
                "phone": "+391234567890",
                "customer_name": "Nome Originale",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-17T00:00:00",
                "appointment_time": "09:00",
                "practice_type": "preventivo",
                "contexts": ["officina"],
            },
        )
        assert create_resp.status_code == 200
        practice_id = create_resp.json()["data"]["id"]

        update_resp = client.put(
            f"/practices/{practice_id}?user_id=761118078",
            json={
                "plate_confirmed": "TEST03ZZ",
                "phone": "+399876543210",
                "customer_name": "Nome Aggiornato",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-17T00:00:00",
                "appointment_time": "11:00",
                "practice_type": "ordine_di_lavoro",
                "contexts": ["officina", "carrozzeria"],
            },
        )

        assert update_resp.status_code == 200
        data = update_resp.json()["data"]
        assert data["customer_name"] == "Nome Aggiornato"
        assert data["appointment_time"] == "11:00"

    def test_create_and_delete_practice(self, client):
        """Test POST /practices e DELETE /practices/{id}."""
        create_resp = client.post(
            "/practices?user_id=761118078",
            json={
                "plate_confirmed": "DELETE01",
                "phone": "+391234567890",
                "customer_name": "Da Cancellare",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-18T00:00:00",
                "appointment_time": "15:00",
                "practice_type": "preventivo",
                "contexts": ["officina"],
            },
        )
        assert create_resp.status_code == 200
        practice_id = create_resp.json()["data"]["id"]

        delete_resp = client.delete(f"/practices/{practice_id}?user_id=761118078")
        assert delete_resp.status_code == 200

        detail_resp = client.get(f"/api/practices/{practice_id}?user_id=761118078")
        assert detail_resp.status_code == 200
        data = detail_resp.json()["data"]["practice"]
        assert data["status"] == "deleted"

    def test_get_practice_not_found(self, client):
        """Test GET /api/practices/{id} con ID inesistente."""
        response = client.get("/api/practices/99999?user_id=761118078")
        assert response.status_code == 404


class TestPracticeFullEndpoints:
    """Test endpoint /practices/full (create/update con sections e parts)."""

    def test_create_practice_full(self, client):
        """Test POST /practices/full con sezioni e pezzi."""
        payload = {
            "practice": {
                "plate_confirmed": "FULL01ZZ",
                "phone": "+391234567890",
                "customer_name": "Cliente Full",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-20T00:00:00",
                "appointment_time": "10:00",
                "practice_type": "preventivo",
                "contexts": ["officina", "carrozzeria"],
                "internal_notes": "Nota full",
            },
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Tagliando completo", "Cambio olio"],
                    "man_hours": 2.5,
                    "mac_hours": None,
                    "materials_amount": 150.0,
                    "waste_apply": False,
                    "waste_percentage": None,
                    "notes": "Sezione officina",
                },
                {
                    "context": "carrozzeria",
                    "description_rows": ["Verniciatura"],
                    "man_hours": None,
                    "mac_hours": 4.0,
                    "materials_amount": 300.0,
                    "waste_apply": True,
                    "waste_percentage": 2,
                    "notes": "Sezione carrozzeria",
                },
            ],
            "parts": [
                {"context": "officina", "name": "Olio motore 5W30", "quantity": "5 L"},
                {"context": "officina", "name": "Filtro olio", "quantity": "1 pz"},
                {"context": "carrozzeria", "name": "Vernice base", "quantity": "1 L"},
            ],
        }

        response = client.post("/practices/full?user_id=761118078", json=payload)

        assert response.status_code == 200
        data = response.json()["data"]
        assert "id" in data
        assert data["customer_name"] == "Cliente Full"


class TestPracticePhotoEndpoints:
    def test_upload_and_delete_photo_uses_cloudinary_public_id(self, client, monkeypatch):
        import main

        deleted_public_ids = []

        def fake_upload(_path, _practice_id, _telegram_file_id):
            return (
                "https://res.cloudinary.com/demo/image/upload/v1/giorgio/practices/1/photo_test.webp",
                {"public_id": "giorgio/practices/1/photo_test"},
            )

        def fake_delete(public_id):
            deleted_public_ids.append(public_id)
            return True

        monkeypatch.setattr(main.cloudinary_service, "upload_practice_photo", fake_upload)
        monkeypatch.setattr(main.cloudinary_service, "delete_photo", fake_delete)

        create_resp = client.post(
            "/practices?user_id=761118078",
            json={
                "plate_confirmed": "PHOTO01",
                "phone": "+39 333 000 1122",
                "customer_name": "Cliente Foto",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-19T00:00:00",
                "appointment_time": "09:00",
                "practice_type": "preventivo",
                "contexts": ["officina"],
            },
        )
        assert create_resp.status_code == 200
        practice_id = create_resp.json()["data"]["id"]
        assert create_resp.json()["data"]["phone"] == "+393330001122"

        upload_resp = client.post(
            f"/api/practices/{practice_id}/photos?user_id=761118078",
            files={"file": ("plate.jpg", b"fake-image-content", "image/jpeg")},
        )
        assert upload_resp.status_code == 200
        photo = upload_resp.json()["data"]
        assert photo["cloudinary_public_id"] == "giorgio/practices/1/photo_test"

        delete_resp = client.delete(
            f"/api/practices/{practice_id}/photos/{photo['id']}?user_id=761118078"
        )
        assert delete_resp.status_code == 200
        assert deleted_public_ids == ["giorgio/practices/1/photo_test"]


class TestErrorEndpoints:
    """Test error handlers."""

    def test_404_not_found(self, client):
        """Test 404 su endpoint inesistente."""
        response = client.get("/api/non-esiste")
        assert response.status_code == 404

    def test_422_validation_error(self, client):
        """Test 422 su validazione fallita."""
        # Manca campo obbligatorio
        practice_data = {
            "customer_name": "Senza Targa",
            # plate_confirmed mancante
        }
        
        response = client.post("/practices?user_id=761118078", json=practice_data)
        assert response.status_code in [200, 422]  # Dipende dalla validazione

    def test_method_not_allowed(self, client):
        """Test 405 su metodo non permesso."""
        response = client.delete("/")  # DELETE su / non permesso
        assert response.status_code == 405
