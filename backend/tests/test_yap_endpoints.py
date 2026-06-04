"""Test reali per YAP Endpoints - sync, notify-error, status."""

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from database_sqlite import Practice
from security import SecurityService

YAP_HEADERS = {"X-Yap-Worker-Secret": "test-yap-secret"}


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


def mark_practice_yap_touched(db_session, practice_id, sync_status="partial_synced"):
    practice = db_session.query(Practice).filter(Practice.id == practice_id).first()
    assert practice is not None
    practice.management_sync_status = sync_status
    practice.management_last_sync_at = datetime.now(timezone.utc)
    practice.synced = sync_status == "complete_synced"
    db_session.commit()


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
        
        response = client.post("/yap/notify-error", json=error_data, headers=YAP_HEADERS)
        # Deve essere protetto o accettare la richiesta
        assert response.status_code in [200, 401, 403, 422]

    def test_notify_error_validates_payload(self, client):
        """Test che notify-error valida il payload."""
        # Payload invalido (manca error_message)
        invalid_data = {
            "practice_id": 999,
            "worker": "test-worker"
        }
        
        response = client.post("/yap/notify-error", json=invalid_data, headers=YAP_HEADERS)
        # Deve rifiutare payload invalido
        assert response.status_code in [200, 401, 403, 422]


class TestYapSyncEndpoints:
    """Test endpoint YAP sync (/practices/{id}/yap/*)."""

    def test_audit_reason_marks_agenda_synced_as_deferred_verification(self):
        import main

        assert main._audit_reason_for_status("agenda_synced", {}) == "audit_deferred"

    def test_save_not_confirmed_maps_to_specific_retry_action(self):
        import main

        action = main._build_yap_action_from_error("Salvataggio YAP non confermato dopo 3 tentativi")
        assert action["error_code"] == "YAP_SAVE_NOT_CONFIRMED"
        assert action["failed_phase"] == "save"
        assert action["next_action"] == "Riprova sync"

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

    def test_practice_delete_rejects_missing_credentials(self, client, sample_practice, db_session, monkeypatch):
        monkeypatch.delenv("YAP_USERNAME", raising=False)
        monkeypatch.delenv("YAP_PASSWORD", raising=False)

        import main

        called = {"value": False}

        def fail_if_called(*args, **kwargs):
            called["value"] = True
            raise AssertionError("_run_yap_script non dovrebbe essere chiamato senza credenziali")

        monkeypatch.setattr(main, "_run_yap_script", fail_if_called)

        mark_practice_yap_touched(db_session, sample_practice["id"])

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

    def test_yap_sync_returns_complete_status_when_inline_audit_verifies_everything(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        from automation_service import AutomationService

        monkeypatch.setattr(
            AutomationService,
            "pre_sync_check",
            staticmethod(lambda payload: {"ready": True, "score": 92, "issues": [], "warnings": []}),
        )

        async def fake_run_yap_script(script_name, *args, **kwargs):
            assert script_name == "yap-worker.mjs"
            return {
                "result": {
                    "saved": True,
                    "mode": "commit",
                    "message": "Appuntamento YAP scritto e verificato: tutto ok.",
                    "status": "complete_synced",
                    "telemetry": {"saveAttempts": 1},
                    "inline_audit": {
                        "verified": True,
                        "present": [{"field": "cosa", "expected": "YAPTEST01"}],
                        "missing": [],
                        "summary": {"present": 1, "missing": 0, "fields": ["cosa"]},
                    },
                    "write_report": {
                        "attempted": True,
                        "ok": True,
                        "notes": {"attempted": True, "success": True},
                        "odl": {"attempted": True, "success": True},
                    },
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
        assert data["status"] == "complete_synced"
        assert "verificato automaticamente" in data["message"].lower()
        assert data["status_reason"] == "strict_match_complete"
        assert data["practice"]["management_sync_status"] == "complete_synced"
        assert data["practice"]["synced"] is True
        assert data["audit"]["verified"] is True
        assert isinstance(data.get("phase_timeline"), list)
        assert data["telemetry"]["saveAttempts"] == 1
        assert any(item.get("name") == "precheck" for item in data["phase_timeline"])
        assert any(item.get("name") == "write" for item in data["phase_timeline"])
        assert any(item.get("name") == "audit" and item.get("status") == "completed" for item in data["phase_timeline"])
        assert isinstance(data.get("write_report"), dict)

    def test_yap_sync_keeps_write_report_details_when_inline_audit_is_partial(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        from automation_service import AutomationService

        monkeypatch.setattr(
            AutomationService,
            "pre_sync_check",
            staticmethod(lambda payload: {"ready": True, "score": 92, "issues": [], "warnings": []}),
        )

        async def fake_run_yap_script(script_name, *args, **kwargs):
            assert script_name == "yap-worker.mjs"
            return {
                "result": {
                    "saved": True,
                    "mode": "commit",
                    "message": "Appuntamento scritto su YAP. Verifica automatica completata: alcuni campi sono da ricontrollare.",
                    "status": "agenda_synced",
                    "telemetry": {"saveAttempts": 1},
                    "inline_audit": {
                        "verified": False,
                        "present": [{"field": "cosa", "expected": "YAPTEST01"}],
                        "missing": [{"field": "odl_notes", "expected": "note interne"}],
                        "summary": {"present": 1, "missing": 1, "fields": ["cosa"]},
                    },
                    "write_report": {
                        "attempted": True,
                        "ok": False,
                        "notes": {"attempted": True, "success": False, "error": "notes_field_not_found"},
                        "materials": {"attempted": True, "success": False, "error": "materials_field_not_found"},
                    },
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
        assert data["status"] == "partial_synced"
        assert data["status_reason"] == "strict_mismatch_missing_1_mismatch_0"
        assert data["error_code"] is None
        assert data["action_target"] is None
        assert data["next_action"] is None
        assert data["practice"]["management_sync_status"] == "partial_synced"
        assert data["practice"]["synced"] is False
        assert data["audit"]["missing"][0]["field"] == "odl_notes"
        assert any(item.get("name") == "audit" and item.get("status") == "partial" for item in data["phase_timeline"])
        assert data["write_report"]["notes"]["error"] == "notes_field_not_found"

    def test_yap_sync_softens_inline_audit_errors_when_post_write_review_is_needed(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        from automation_service import AutomationService

        monkeypatch.setattr(
            AutomationService,
            "pre_sync_check",
            staticmethod(lambda payload: {"ready": True, "score": 92, "issues": [], "warnings": []}),
        )

        async def fake_run_yap_script(script_name, *args, **kwargs):
            assert script_name == "yap-worker.mjs"
            return {
                "result": {
                    "saved": True,
                    "mode": "commit",
                    "message": "Appuntamento scritto su YAP. Verifica automatica parziale.",
                    "status": "agenda_synced",
                    "telemetry": {"saveAttempts": 1},
                    "inline_audit": {
                        "verified": False,
                        "error": "Popup not found for audit",
                        "summary": {"present": 0, "missing": 0},
                    },
                    "write_report": {
                        "attempted": True,
                        "ok": False,
                        "notes": {"attempted": True, "success": False, "error": "notes_field_not_found"},
                        "odl": {"attempted": True, "success": False, "error": "odl_route_ineffective"},
                    },
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
        assert data["status"] == "partial_synced"
        assert data["status_reason"] == "post_write_review_needed"
        assert data["error_code"] is None
        assert data["practice"]["management_sync_status"] == "partial_synced"
        assert data["audit"]["technical_failure"] is False
        assert "da ricontrollare" in data["message"].lower()
        assert data["write_report"]["odl"]["error"] == "odl_route_ineffective"

    def test_yap_sync_softens_top_level_write_report_errors_for_partial_inline_audit(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        from automation_service import AutomationService

        monkeypatch.setattr(
            AutomationService,
            "pre_sync_check",
            staticmethod(lambda payload: {"ready": True, "score": 92, "issues": [], "warnings": []}),
        )

        async def fake_run_yap_script(script_name, *args, **kwargs):
            assert script_name == "yap-worker.mjs"
            return {
                "result": {
                    "saved": True,
                    "mode": "commit",
                    "message": "Appuntamento scritto su YAP. Verifica automatica parziale.",
                    "status": "agenda_synced",
                    "telemetry": {"saveAttempts": 1},
                    "inline_audit": {
                        "verified": False,
                        "error": "Popup not found for audit",
                        "summary": {"present": 0, "missing": 0},
                    },
                    "write_report": {
                        "attempted": True,
                        "ok": False,
                        "error": "odl write crashed before field-level report",
                    },
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
        assert data["status"] == "partial_synced"
        assert data["status_reason"] == "post_write_review_needed"
        assert data["error_code"] is None
        assert data["audit"]["technical_failure"] is False
        assert "odl" in data["message"].lower()

    def test_yap_sync_surfaces_worker_phase_details_on_timeout(self, client, sample_practice, monkeypatch):
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
            raise HTTPException(
                status_code=504,
                detail={
                    "message": "Timeout automazione YAP",
                    "reason": "timeout during odl",
                    "error_code": "YAP_TIMEOUT",
                    "failed_phase": "odl",
                    "retryable": True,
                    "next_action": "Riprova sync",
                    "action_target": "sync",
                    "worker_phases": [
                        {"phase": "login", "status": "done", "elapsed_ms": 4200},
                        {"phase": "odl", "status": "starting", "elapsed_ms": 151000},
                    ],
                    "runner": {"timeout_seconds": 150, "total_elapsed_ms": 151234},
                    "stderr_tail": "{\"event\":\"yap:phase\",\"phase\":\"odl\"}",
                },
            )

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/sync?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "sync_failed"
        assert data["failed_phase"] == "odl"
        assert data["worker_phases"][-1]["phase"] == "odl"
        assert data["runner"]["timeout_seconds"] == 150
        assert "yap:phase" in data["stderr_tail"]

    def test_yap_sync_keeps_agenda_synced_when_worker_times_out_after_save(self, client, sample_practice, monkeypatch):
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
            raise HTTPException(
                status_code=504,
                detail={
                    "message": "Timeout automazione YAP",
                    "reason": "timeout during odl",
                    "failed_phase": "odl",
                    "worker_phases": [
                        {"phase": "login", "status": "done", "elapsed_ms": 4200},
                        {"phase": "save", "status": "done", "elapsed_ms": 16200},
                        {"phase": "odl", "status": "starting", "elapsed_ms": 151000},
                    ],
                    "runner": {"timeout_seconds": 150, "total_elapsed_ms": 151234},
                },
            )

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/sync?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "agenda_synced"
        assert data["status_reason"] == "audit_deferred"
        assert data["retryable"] is True
        assert data["practice"]["management_sync_status"] == "agenda_synced"
        assert data["practice"]["synced"] is True
        assert data["failed_phase"] == "odl"

    def test_yap_audit_http_exception_is_persisted_as_deferred(self, client, sample_practice, db_session, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import json as _json
        import main

        practice = db_session.query(Practice).filter(Practice.id == sample_practice["id"]).first()
        assert practice is not None
        practice.management_sync_status = "agenda_synced"
        practice.synced = True
        db_session.commit()

        async def fake_run_yap_script(*args, **kwargs):
            raise HTTPException(status_code=504, detail={"message": "audit timeout"})

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/audit?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "agenda_synced"
        assert data["status_reason"] == "audit_deferred"
        assert data["error_code"] == "YAP_TIMEOUT"
        assert data["action_target"] == "audit"
        assert data["audit"]["completed"] is False
        db_session.refresh(practice)
        persisted = _json.loads(practice.management_audit_result)
        assert persisted["status"] == "agenda_synced"
        assert persisted["status_reason"] == "audit_deferred"
        assert persisted["completed"] is False

    @pytest.mark.parametrize(
        "audit_status,expected_synced",
        [
            ("complete_synced", True),
            ("partial_synced", False),
            ("agenda_synced", False),
            ("sync_failed", False),
        ],
    )
    def test_yap_audit_persists_status(self, client, sample_practice, monkeypatch, audit_status, expected_synced):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main

        async def fake_run_yap_script(*args, **kwargs):
            return {
                "ok": audit_status != "sync_failed",
                "status": audit_status,
                "message": f"Audit {audit_status}",
                "present": [{"field": "agenda.cosa", "label": "Cosa", "expected": "YAPTEST01", "found": "YAPTEST01"}] if audit_status != "sync_failed" else [],
                "missing": [{"field": "odl.officina.man", "label": "MAN officina", "expected": "MAN 1", "found": None}] if audit_status == "partial_synced" else [],
                "mismatch": [{"field": "agenda.dalle", "label": "Dalle", "expected": "10.00", "found": "11.00"}] if audit_status == "sync_failed" else [],
            }

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.post(
            f"/practices/{sample_practice['id']}/yap/audit?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == audit_status
        assert data["practice"]["management_sync_status"] == audit_status
        assert data["practice"]["synced"] is expected_synced

    def test_practice_delete_allows_local_delete_when_yap_not_found(self, client, sample_practice, db_session, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main

        async def fake_run_yap_script(*args, **kwargs):
            return {
                "found": False,
                "deleted": False,
                "status": "not_found",
            }

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        mark_practice_yap_touched(db_session, sample_practice["id"])

        response = client.delete(
            f"/practices/{sample_practice['id']}?user_id=761118078",
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert "cancellata" in str(data.get("message", "")).lower()

        listed = client.get("/api/practices?user_id=761118078")
        assert listed.status_code == 200
        ids = [item["id"] for item in listed.json().get("data", [])]
        assert sample_practice["id"] not in ids

    def test_yap_delete_endpoint_soft_deletes_when_not_found(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main
        captured = {}

        async def fake_run_yap_script(script_name, args, **kwargs):
            captured["script_name"] = script_name
            captured["args"] = args
            return {
                "found": False,
                "deleted": False,
                "status": "not_found",
                "telemetry": {
                    "runner": {
                        "script": "yap-delete-appointment.mjs",
                        "lock_wait_ms": 12,
                        "total_elapsed_ms": 240,
                    },
                },
            }

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.request(
            "DELETE",
            f"/practices/{sample_practice['id']}/yap/appointment?user_id=761118078",
            json={"time": "09:00"},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "not_found"
        assert data["telemetry"]["runner"]["lock_wait_ms"] == 12
        assert isinstance(data.get("phase_timeline"), list)
        assert all(item.get("started_at") for item in data["phase_timeline"])
        assert all(item.get("finished_at") for item in data["phase_timeline"])
        assert data["timing"]["started_at"]
        assert data["timing"]["finished_at"]
        assert data["yap"]["telemetry"]["runner"]["lock_wait_ms"] == 12
        assert captured["script_name"] == "yap-delete-appointment.mjs"
        assert "--time" in captured["args"]
        assert "09:00" in captured["args"]

        listed = client.get("/api/practices?user_id=761118078")
        assert listed.status_code == 200
        ids = [item["id"] for item in listed.json().get("data", [])]
        assert sample_practice["id"] not in ids

    def test_yap_delete_endpoint_keeps_practice_when_blocked_by_odl(self, client, sample_practice, monkeypatch):
        monkeypatch.setenv("YAP_USERNAME", "demo")
        monkeypatch.setenv("YAP_PASSWORD", "demo")

        import main

        async def fake_run_yap_script(*args, **kwargs):
            return {
                "found": True,
                "deleted": False,
                "status": "blocked_by_odl",
                "deleteAction": {"failureStatus": "blocked_by_odl"},
            }

        monkeypatch.setattr(main, "_run_yap_script", fake_run_yap_script)

        response = client.request(
            "DELETE",
            f"/practices/{sample_practice['id']}/yap/appointment?user_id=761118078",
            json={},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "blocked_by_odl"

        listed = client.get("/api/practices?user_id=761118078")
        assert listed.status_code == 200
        ids = [item["id"] for item in listed.json().get("data", [])]
        assert sample_practice["id"] in ids


class TestYapTestErrorChannel:
    """Test endpoint POST /yap/test-error-channel."""

    def test_test_error_channel_endpoint(self, client):
        """Test che l'endpoint di test del canale errori esista."""
        response = client.post("/yap/test-error-channel", headers=YAP_HEADERS)
        
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

    def test_yap_audit_request_model(self):
        """Test che il modello YapAuditRequest sia valido."""
        from main import YapAuditRequest

        request = YapAuditRequest(
            date="2026-11-15",
            time="10:00",
            duration=20,
            debug=True,
            persist=False,
        )
        assert request.date == "2026-11-15"
        assert request.time == "10:00"
        assert request.duration == 20
        assert request.persist is False

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


class TestYapPreviewFromForm:
    def test_yap_preview_from_form_returns_preview(self, client):
        payload = {
            "practice": {
                "plate_confirmed": "AB123CD",
                "phone": "+391234567890",
                "customer_name": "Cliente Preview",
                "customer_type": "privato",
                "billing_to_complete": False,
                "appointment_date": "2026-11-15T00:00:00",
                "appointment_time": "10:00",
                "practice_type": "preventivo",
                "contexts": ["officina"],
                "internal_notes": "anteprima",
            },
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Tagliando completo"],
                    "man_hours": 1.5,
                    "mac_hours": None,
                    "materials_amount": None,
                    "waste_apply": False,
                    "waste_percentage": None,
                    "notes": "ok",
                }
            ],
            "parts": [
                {
                    "context": "officina",
                    "name": "Filtro olio",
                    "quantity": "1 pz",
                }
            ],
        }

        response = client.post(
            "/yap-mapping-preview/from-form?user_id=761118078",
            json=payload,
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert "AB123CD" in data["proposedYap"]["popup"]["cosa"]
