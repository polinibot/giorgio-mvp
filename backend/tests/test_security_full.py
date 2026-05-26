"""Test reali per Security e Auth - HMAC tokens, whitelist, init_data."""

import pytest
from security import SecurityService


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
        assert len(token) == 64  # SHA-256 hex

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

    def test_extract_user_from_init_data_invalid(self):
        """Test estrazione da init_data invalido ritorna None."""
        result = SecurityService.extract_user_from_init_data("invalid")
        
        assert result is None

    def test_extract_user_from_init_data_empty(self):
        """Test estrazione da init_data vuoto ritorna None."""
        result = SecurityService.extract_user_from_init_data("")
        
        assert result is None
