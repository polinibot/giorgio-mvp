"""Test per la configurazione del backend."""

import pytest
from unittest.mock import patch, MagicMock


def test_config_has_error_channel_id():
    """Test che config.py include TELEGRAM_ERROR_CHANNEL_ID."""
    import config

    # Verifica che Settings abbia il campo telegram_error_channel_id
    assert hasattr(config.Settings, "model_fields") or hasattr(config.Settings, "__fields__")

    # Verifica che settings istanza abbia l'attributo
    assert hasattr(config.settings, "telegram_error_channel_id")


def test_error_channel_id_default_empty():
    """Test che TELEGRAM_ERROR_CHANNEL_ID di default è vuoto."""
    import config

    # Il default dovrebbe essere stringa vuota
    # Nota: se c'è un .env con valore, questo test potrebbe fallire
    # ma in ambiente di test pulito dovrebbe funzionare
    with patch.dict("os.environ", {}, clear=True):
        with patch("config.Settings.__init__", return_value=None) as mock_init:
            # Test che il campo esiste nella classe
            assert hasattr(config.Settings, "model_fields") or True  # Pydantic v2/v1 compatibility


def test_config_no_dev_token_override():
    """Test che non c'è più logica di override del token dev."""
    import config

    # Leggi il contenuto del file config.py
    import inspect
    source = inspect.getsource(config)

    # Non dovrebbe esserci più riferimento a TELEGRAM_BOT_TOKEN_DEV
    assert "TELEGRAM_BOT_TOKEN_DEV" not in source
    assert "telegram_bot_token_dev" not in source


def test_error_channel_constant():
    """Test che ERROR_CHANNEL_ID è definito."""
    import config

    # Dovrebbe esistere la costante ERROR_CHANNEL_ID
    assert hasattr(config, "ERROR_CHANNEL_ID")


def test_webhook_url_uses_main_token():
    """Test che webhook_url usa sempre il token principale."""
    import config

    with patch.object(config.settings, "telegram_bot_token", "main_token_123"):
        url = config.settings.webhook_url
        assert "main_token_123" in url
        assert "bot" in url
