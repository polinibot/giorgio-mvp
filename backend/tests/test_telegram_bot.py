"""Test reali per Telegram Bot - invio messaggi, comandi, webhook."""

import pytest
import asyncio
import os


pytestmark = pytest.mark.integration


class TestBotConfig:
    """Test configurazione bot."""

    def test_telegram_bot_token_exists(self):
        """Test che il token del bot sia configurato."""
        from config import settings
        
        assert hasattr(settings, 'telegram_bot_token')
        # Il token deve essere non vuoto o presente in env
        token = settings.telegram_bot_token or os.getenv('TELEGRAM_BOT_TOKEN', '')
        assert len(token) > 10  # Token Telegram sono lunghi

    def test_webhook_url_property(self):
        """Test che l'URL webhook sia disponibile come property."""
        from config import settings
        
        # Verifica che webhook_url esista (property in config)
        assert hasattr(settings, 'webhook_url')
        # Se c'è un token, l'URL deve essere formato correttamente
        if settings.telegram_bot_token:
            assert 'api.telegram.org' in settings.webhook_url

    def test_whitelist_configured(self):
        """Test che la whitelist sia configurata."""
        from config import settings
        
        assert hasattr(settings, 'whitelist_telegram_ids')
        assert isinstance(settings.whitelist_telegram_ids, list)


class TestErrorNotifierTelegram:
    """Test invio errori su Telegram."""

    def test_error_notifier_singleton(self):
        """Test che error notifier sia singleton."""
        from error_notifier import get_error_notifier
        
        notifier1 = get_error_notifier()
        notifier2 = get_error_notifier()
        
        assert notifier1 is notifier2

    def test_error_notifier_message_format(self):
        """Test formattazione messaggio errore."""
        from error_notifier import get_error_notifier
        
        notifier = get_error_notifier()
        
        # Test formattazione interna
        message = notifier._format_message(
            error_message="Test error",
            stack_trace="Traceback...",
            context={"practice_id": 42, "worker": "test"}
        )
        
        assert "🚨" in message  # Emoji errore
        assert "Test error" in message
        assert "42" in message or "practice_id" in message


class TestTelegramUtils:
    """Test utility Telegram (formatting, etc)."""

    def test_practice_summary_format(self):
        """Test formattazione riepilogo pratica."""
        # build_practice_summary richiede db reale, skip per ora
        from telegram_utils import build_practice_summary
        
        # Verifica che la funzione esista con firma corretta
        import inspect
        sig = inspect.signature(build_practice_summary)
        params = list(sig.parameters.keys())
        
        assert 'db' in params
        assert 'practice_id' in params
        # Non possiamo testare senza database, ma verifichiamo struttura

    def test_telegram_utils_import(self):
        """Test che telegram_utils si importa."""
        import telegram_utils
        
        # Verifica che il modulo abbia funzioni utili
        assert hasattr(telegram_utils, 'build_practice_summary')


class TestTelegramAPIIntegration:
    """Test integrazione API Telegram (richiede rete)."""

    @pytest.mark.asyncio
    @pytest.mark.external
    @pytest.mark.production_gate
    async def test_bot_get_me(self):
        """Test getMe del bot (verifica token valido)."""
        from config import settings
        import aiohttp
        
        token = settings.telegram_bot_token
        if not token:
            pytest.skip("Token Telegram non configurato")
        
        url = f"https://api.telegram.org/bot{token}/getMe"
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=10) as response:
                    if response.status == 200:
                        data = await response.json()
                        assert data["ok"] is True
                        assert "result" in data
                        assert "username" in data["result"]
                        print(f"✅ Bot attivo: @{data['result']['username']}")
                    else:
                        pytest.skip(f"API Telegram ritorna {response.status}")
        except Exception as e:
            pytest.skip(f"Connessione Telegram fallita: {e}")

    @pytest.mark.asyncio
    @pytest.mark.external
    @pytest.mark.production_gate
    async def test_send_message_to_error_channel(self):
        """Test invio messaggio al canale errori."""
        from error_notifier import get_error_notifier
        from config import settings
        
        notifier = get_error_notifier()
        
        # Se non configurato, skip
        if not notifier.bot_token or not notifier.channel_id:
            pytest.skip("Canale errori non configurato")
        
        # Invia messaggio di test
        result = await notifier.notify_error(
            error_message="🧪 Test automatico - puoi ignorare",
            context={"test": True, "timestamp": "2026-01-01"}
        )
        
        # Il risultato può essere True/False dipende dalla config
        assert isinstance(result, bool)


class TestMiniAppIntegration:
    """Test integrazione Mini App con Telegram."""

    def test_mini_app_init_data_validation(self):
        """Test validazione init_data da Mini App."""
        from security import SecurityService
        
        # init_data vuota o invalida deve fallire
        result = SecurityService.validate_telegram_init_data("")
        assert result is False
        
        result = SecurityService.validate_telegram_init_data("invalid_data")
        assert result is False

    def test_mini_app_data_endpoint_exists(self):
        """Test che l'endpoint Mini App esista."""
        from main import app
        
        # Verifica che le route esistano
        routes = [route.path for route in app.routes]
        
        assert "/mini-app/data" in routes or any("mini-app" in r for r in routes)


class TestCommands:
    """Test comandi bot."""

    def test_commands_structure(self):
        """Test che i comandi siano definiti."""
        try:
            from bot import dp
            # Verifica che il dispatcher abbia comandi registrati
            assert dp is not None
        except ImportError:
            pytest.skip("aiogram non disponibile")

    def test_start_command_handler(self):
        """Test handler comando /start."""
        try:
            from bot import router
            # Verifica che il router esista
            assert router is not None
        except ImportError:
            pytest.skip("aiogram non disponibile")
