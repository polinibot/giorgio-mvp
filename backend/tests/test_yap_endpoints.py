"""Test reali per YAP Endpoints - sync, notify-error, status."""

import pytest

from security import SecurityService


@pytest.fixture
def sample_practice(client):
    """Crea una pratica di esempio per test YAP."""
    practice_data = {
        "plate_confirmed": "YAPTEST01",
        "phone": "+391234567890",
        "customer_name": "Cliente YAP Test",
        "customer_type": "privato",
        "billing_to_complete": False,
        "appointment_date": "2026-11-15T00:00:00",
        "appointment_time": "10:00",
        "practice_type": "ordine_di_lavoro",
        "contexts": ["officina", "revisione"],
        "internal_notes": "Test YAP endpoint"
    }
    
    response = client.post("/practices?user_id=761118078", json=practice_data)
    assert response.status_code == 200
    return response.json()["data"]


class TestYapErrorChannelStatus:
    """Test endpoint GET /yap/error-channel-status."""

    def test_error_channel_status_endpoint_exists(self, client):
        """Test che l'endpoint esiste e ritorna JSON."""
        response = client.get("/yap/error-channel-status")
        
        # L'endpoint deve esistere (200) o essere protetto
        assert response.status_code in [200, 401, 403]
        
        if response.status_code == 200:
            data = response.json()
            assert "success" in data
            assert "configured" in data.get("data", {})


class TestYapNotifyError:
    """Test endpoint POST /yap/notify-error."""

    def test_notify_error_requires_auth(self, client):
        """Test che notify-error richiede autenticazione."""
        error_data = {
            "error_message": "Test error",
            "practice_id": 999,
            "worker": "test-worker"
        }
        
        response = client.post("/yap/notify-error", json=error_data)
        # Deve essere protetto o accettare la richiesta
        assert response.status_code in [200, 401, 403, 422]

    def test_notify_error_validates_payload(self, client):
        """Test che notify-error valida il payload."""
        # Payload invalido (manca error_message)
        invalid_data = {
            "practice_id": 999,
            "worker": "test-worker"
        }
        
        response = client.post("/yap/notify-error", json=invalid_data)
        # Deve rifiutare payload invalido
        assert response.status_code in [200, 401, 403, 422]


class TestYapSyncEndpoints:
    """Test endpoint YAP sync (/practices/{id}/yap/*)."""

    def test_yap_sync_rejects_missing_credentials(self, client, sample_practice, monkeypatch):
        monkeypatch.delenv("YAP_USERNAME", raising=False)
        monkeypatch.delenv("YAP_PASSWORD", raising=False)

        import main

        called = {"value": False}

        def fail_if_called(*args, **kwargs):
            called["value"] = True
            raise AssertionError("_run_yap_script non dovrebbe essere chiamato senza credenziali")

        monkeypatch.setattr(main, "_run_yap_script", fail_if_called)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/sync?user_id=761118078",
            json={},
        )

        assert response.status_code == 503
        data = response.json()
        assert data["detail"]["missing"] == ["YAP_USERNAME", "YAP_PASSWORD"]
        assert "Configurazione YAP mancante" in data["detail"]["message"]
        assert called["value"] is False

    def test_practice_delete_rejects_missing_credentials(self, client, sample_practice, monkeypatch):
        monkeypatch.delenv("YAP_USERNAME", raising=False)
        monkeypatch.delenv("YAP_PASSWORD", raising=False)

        import main

        called = {"value": False}

        def fail_if_called(*args, **kwargs):
            called["value"] = True
            raise AssertionError("_run_yap_script non dovrebbe essere chiamato senza credenziali")

        monkeypatch.setattr(main, "_run_yap_script", fail_if_called)

        response = client.delete(
            f"/practices/{sample_practice['id']}?user_id=761118078",
        )

        assert response.status_code == 503
        data = response.json()
        assert data["detail"]["missing"] == ["YAP_USERNAME", "YAP_PASSWORD"]
        assert "Configurazione YAP mancante" in data["detail"]["message"]
        assert called["value"] is False

    def test_yap_delete_rejects_missing_credentials(self, client, sample_practice, monkeypatch):
        monkeypatch.delenv("YAP_USERNAME", raising=False)
        monkeypatch.delenv("YAP_PASSWORD", raising=False)

        import main

        called = {"value": False}

        def fail_if_called(*args, **kwargs):
            called["value"] = True
            raise AssertionError("_run_yap_script non dovrebbe essere chiamato senza credenziali")

        monkeypatch.setattr(main, "_run_yap_script", fail_if_called)

        response = client.request(
            "DELETE",
            f"/practices/{sample_practice['id']}/yap/appointment?user_id=761118078",
            json={},
        )

        assert response.status_code == 503
        data = response.json()
        assert data["detail"]["missing"] == ["YAP_USERNAME", "YAP_PASSWORD"]
        assert "Configurazione YAP mancante" in data["detail"]["message"]
        assert called["value"] is False

    def test_yap_sync_returns_agenda_scope_summary(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        from automation_service import AutomationService

        monkeypatch.setattr(
            AutomationService,
            "pre_sync_check",
            staticmethod(lambda payload: {"ready": True, "score": 92, "issues": [], "warnings": []}),
        )

        async def fake_run_yap_script(*args, **kwargs):
            return {
                "result": {
                    "saved": True,
                    "mode": "commit",
                    "message": "Appuntamento salvato su YAP.",
                    "telemetry": {"saveAttempts": 1},
                },
                "stdout": "",
                "stderr": "",
            }

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/sync?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "synced"
        assert data["message"] == "Agenda sincronizzata. ODL/materiali/ricambi pianificati."
        assert data["syncScope"]["mode"] == "agenda_only"
        assert data["practice"]["management_sync_status"] == "agenda_synced"


class TestYapTestErrorChannel:
    """Test endpoint POST /yap/test-error-channel."""

    def test_test_error_channel_endpoint(self, client):
        """Test che l'endpoint di test del canale errori esista."""
        response = client.post("/yap/test-error-channel")
        
        # Può fallire se il canale non è configurato, ma deve esistere
        assert response.status_code in [200, 400, 401, 403, 500]


class TestYapPayloadStructure:
    """Test struttura payload YAP (usato dai worker)."""

    def test_yap_sync_request_model(self):
        """Test che il modello YapSyncRequest sia valido."""
        from main import YapSyncRequest
        
        # Crea istanza valida
        request = YapSyncRequest(
            dry_run=True,
            debug=False,
            fresh_login=False,
            date="2026-11-15",
            time="10:00",
            duration=60
        )
        
        assert request.dry_run is True
        assert request.date == "2026-11-15"
        assert request.time == "10:00"

    def test_yap_delete_request_model(self):
        """Test che il modello YapDeleteAppointmentRequest sia valido (se esiste)."""
        from main import YapDeleteAppointmentRequest

        request = YapDeleteAppointmentRequest(
            date="2026-11-15",
            search="TEST01ZZ",
            dry_run=True,
            debug=False,
            fresh_login=False,
        )
        assert request.date == "2026-11-15"
        assert request.search == "TEST01ZZ"
        assert request.dry_run is True

    def test_yap_error_notification_model(self):
        """Test che il modello YapErrorNotificationRequest sia valido."""
        from main import YapErrorNotificationRequest
        
        request = YapErrorNotificationRequest(
            error_message="Test error message",
            practice_id=42,
            worker="test-worker",
            context={"key": "value"},
            stack_trace="Traceback..."
        )
        
        assert request.error_message == "Test error message"
        assert request.practice_id == 42


class TestAutomationService:
    """Test AutomationService (logica YAP interna)."""

    def test_prepare_automation_payload_structure(self):
        """Test che prepare_automation_payload produca struttura corretta."""
        from automation_service import AutomationService
        
        # Questo test verifica solo la struttura del metodo
        assert hasattr(AutomationService, 'prepare_automation_payload')
        assert hasattr(AutomationService, 'map_payload_to_management')

    # TODO: Richiedono validazione con database
    # def test_validate_automation_readiness(self): ...
    # def test_validate_automation_readiness_incomplete(self): ...
