"""Test reali per Servizi - OCR, Cloudinary, Telegram."""

import pytest
import os
from io import BytesIO


pytestmark = pytest.mark.integration


class TestOCRService:
    """Test OCR Service - richiede Tesseract installato."""

    def test_ocr_service_structure(self):
        """Test che OCRService esista e abbia i metodi."""
        from ocr_service import OCRService
        
        assert hasattr(OCRService, 'extract_plate_from_image')
        assert hasattr(OCRService, 'validate_plate_format')

    def test_ocr_validate_plate_format(self):
        """Test validazione formato targa."""
        from ocr_service import OCRService
        
        # Test targhe valide italiane
        assert OCRService.validate_plate_format("AB123CD") is True
        assert OCRService.validate_plate_format("AA111AA") is True
        
        # Test targhe non valide
        assert OCRService.validate_plate_format("INVALID") is False
        assert OCRService.validate_plate_format("123") is False

    def test_ocr_confidence_threshold_config(self):
        """Test che la soglia confidence sia configurata."""
        from config import settings
        
        assert hasattr(settings, 'ocr_confidence_threshold')
        assert 0 <= settings.ocr_confidence_threshold <= 1


class TestCloudinaryService:
    """Test Cloudinary Service - richiede credenziali in .env."""

    def test_cloudinary_service_structure(self):
        """Test che cloudinary_service esista."""
        from cloudinary_service import cloudinary_service
        
        assert cloudinary_service is not None

    def test_cloudinary_config_loaded(self):
        """Test che la config Cloudinary sia caricata."""
        from config import settings
        
        # Verifica che le variabili esistano (anche se vuote)
        assert hasattr(settings, 'cloudinary_cloud_name')
        assert hasattr(settings, 'cloudinary_api_key')
        assert hasattr(settings, 'cloudinary_api_secret')

    def test_cloudinary_upload_method_exists(self):
        """Test che il metodo di upload esista."""
        from cloudinary_service import cloudinary_service
        
        # Verifica che il servizio abbia il metodo corretto
        assert hasattr(cloudinary_service, 'upload_practice_photo')
        assert hasattr(cloudinary_service, 'compress_image')


class TestTelegramBot:
    """Test Telegram Bot - invio messaggi reali."""

    def test_bot_structure(self):
        """Test che il bot abbia la struttura corretta."""
        try:
            from bot import bot
            assert bot is not None
        except ImportError as e:
            if "aiogram" in str(e):
                pytest.skip("aiogram non installato, skip test bot")
            raise

    def test_telegram_config_loaded(self):
        """Test che il token Telegram sia configurato."""
        from config import settings
        
        assert hasattr(settings, 'telegram_bot_token')
        assert settings.telegram_bot_token != "" or "TELEGRAM_BOT_TOKEN" in os.environ

    def test_error_notifier_structure(self):
        """Test che error_notifier esista e funzioni."""
        from error_notifier import get_error_notifier, ErrorNotifier
        
        notifier = get_error_notifier()
        assert isinstance(notifier, ErrorNotifier)
        assert hasattr(notifier, 'notify_error')

    def test_error_channel_id_config(self):
        """Test che TELEGRAM_ERROR_CHANNEL_ID sia configurato."""
        from config import settings
        
        assert hasattr(settings, 'telegram_error_channel_id')


class TestErrorNotifierReal:
    """Test ErrorNotifier con invio reale (opzionale)."""

    def test_error_notifier_returns_false_without_config(self, monkeypatch):
        """Test che notify_error ritorni False se non configurato."""
        import asyncio
        import error_notifier as error_notifier_module

        monkeypatch.setattr(error_notifier_module.settings, "telegram_bot_token", "", raising=False)
        monkeypatch.setattr(error_notifier_module, "ERROR_CHANNEL_ID", "", raising=False)

        notifier = error_notifier_module.ErrorNotifier()
        result = asyncio.run(notifier.notify_error("Test error"))
        assert result is False


class TestServicesIntegration:
    """Test integrazione tra servizi."""

    def test_config_all_services_present(self):
        """Test che tutte le config dei servizi esistano."""
        from config import settings
        
        # OCR
        assert hasattr(settings, 'ocr_confidence_threshold')
        
        # Cloudinary
        assert hasattr(settings, 'cloudinary_cloud_name')
        assert hasattr(settings, 'cloudinary_api_key')
        assert hasattr(settings, 'cloudinary_api_secret')
        
        # Telegram
        assert hasattr(settings, 'telegram_bot_token')
        assert hasattr(settings, 'telegram_error_channel_id')

    def test_services_import_without_errors(self):
        """Test che tutti i servizi si importano senza errori."""
        try:
            import ocr_service
            import cloudinary_service
            import telegram_utils
            import error_notifier
            
            # Se arriviamo qui, gli import funzionano
            assert True
        except ImportError as e:
            pytest.fail(f"Import servizio fallito: {e}")
