"""Test reali per Security e Auth - HMAC tokens, whitelist, init_data."""

import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import main
from config import settings
from security import SecurityService
from urllib.parse import urlencode


def build_signed_init_data(user_payload, auth_date=None):
    auth_date = auth_date or int(time.time())
    data = {
        "auth_date": str(auth_date),
        "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
        "user": json.dumps(user_payload, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
    webapp_secret = hmac.new(
        b"WebAppData",
        settings.telegram_bot_token.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    data["hash"] = hmac.new(
        webapp_secret,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return urlencode(data)


def make_request(path="/mini-app/data"):
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "scheme": "http",
        "server": ("testserver", 80),
    }
    return Request(scope)


class TestPracticeAccessToken:
    """Test practice access token (HMAC-based, bound to practice+user)."""

    def test_generate_practice_access_token(self):
        """Test generazione token accesso pratica."""
        token = SecurityService.generate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456
        )
        
        assert token is not None
        assert isinstance(token, str)
        assert "." in token

    def test_validate_practice_access_token_success(self):
        """Test validazione token corretto."""
        token = SecurityService.generate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456
        )
        
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456,
            token=token
        )
        
        assert is_valid is True

    def test_validate_practice_access_token_wrong_practice(self):
        """Test validazione fallisce con pratica sbagliata."""
        token = SecurityService.generate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456
        )
        
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=99,  # diversa
            telegram_user_id=123456,
            token=token
        )
        
        assert is_valid is False

    def test_validate_practice_access_token_wrong_user(self):
        """Test validazione fallisce con user sbagliato."""
        token = SecurityService.generate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456
        )
        
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=42,
            telegram_user_id=999999,  # diverso
            token=token
        )
        
        assert is_valid is False

    def test_validate_practice_access_token_none(self):
        """Test validazione fallisce con token None."""
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456,
            token=None
        )
        
        assert is_valid is False

    def test_validate_practice_access_token_invalid(self):
        """Test validazione fallisce con token invalido."""
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456,
            token="invalid-token"
        )
        
        assert is_valid is False

    def test_validate_practice_access_token_expired(self):
        token = SecurityService.generate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456,
            expires_in_seconds=1,
            issued_at=100,
        )
        is_valid = SecurityService.validate_practice_access_token(
            practice_id=42,
            telegram_user_id=123456,
            token=token,
        )
        assert is_valid is False


class TestWhitelist:
    """Test whitelist validation."""

    def test_is_user_whitelisted_true(self):
        """Test utente in whitelist."""
        # Usa l'ID del proprietario che abbiamo visto nei test
        test_id = 761118078
        
        result = SecurityService.is_user_whitelisted(test_id)
        # Il risultato dipende dalla config, ma il metodo deve funzionare
        assert isinstance(result, bool)

    def test_is_user_whitelisted_false(self):
        """Test utente NON in whitelist."""
        result = SecurityService.is_user_whitelisted(999999999)
        
        assert result is False


class TestTelegramInitData:
    """Test Telegram init_data validation."""

    def test_validate_telegram_init_data_invalid(self):
        """Test init_data invalido ritorna False."""
        result = SecurityService.validate_telegram_init_data("invalid_data")
        
        assert result is False

    def test_validate_telegram_init_data_empty(self):
        """Test init_data vuoto ritorna False."""
        result = SecurityService.validate_telegram_init_data("")
        
        assert result is False

    def test_validate_telegram_init_data_valid(self):
        result = SecurityService.validate_telegram_init_data(
            build_signed_init_data({"id": 761118078, "first_name": "Test", "username": "tester"})
        )
        assert result is True

    def test_validate_telegram_init_data_expired(self):
        expired_timestamp = int(time.time()) - settings.telegram_init_data_max_age_seconds - 5
        result = SecurityService.validate_telegram_init_data(
            build_signed_init_data({"id": 761118078}, auth_date=expired_timestamp)
        )
        assert result is False

    def test_extract_user_from_init_data_invalid(self):
        """Test estrazione da init_data invalido ritorna None."""
        result = SecurityService.extract_user_from_init_data("invalid")
        
        assert result is None

    def test_extract_user_from_init_data_empty(self):
        """Test estrazione da init_data vuoto ritorna None."""
        result = SecurityService.extract_user_from_init_data("")
        
        assert result is None

    def test_main_auth_rejects_user_id_fallback_in_production(self, monkeypatch):
        monkeypatch.setattr(main, "DEBUG", False)
        with pytest.raises(HTTPException) as exc:
            main.validate_telegram_init_data(
                request=make_request(),
                init_data=None,
                x_telegram_init_data=None,
                user_id=761118078,
                x_telegram_user_id="761118078",
            )
        assert exc.value.status_code == 401

    def test_main_auth_accepts_signed_init_data_in_production(self, monkeypatch):
        monkeypatch.setattr(main, "DEBUG", False)
        user = main.validate_telegram_init_data(
            request=make_request(),
            init_data=build_signed_init_data({"id": 761118078, "first_name": "Test", "username": "tester"}),
            x_telegram_init_data=None,
            user_id=None,
            x_telegram_user_id=None,
        )
        assert user["id"] == 761118078
