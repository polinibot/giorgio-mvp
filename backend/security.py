import hmac
import hashlib
import logging
from urllib.parse import parse_qs, unquote, unquote_plus
from typing import Dict, Optional
from config import settings

logger = logging.getLogger(__name__)


class SecurityService:
    """Servizio per la sicurezza minima del bot e Mini App."""
    
    @staticmethod
    def is_user_whitelisted(telegram_user_id: int) -> bool:
        """
        Verifica se l'utente Telegram è nella whitelist.
        """
        return telegram_user_id in settings.whitelist_telegram_ids
    
    @staticmethod
    def validate_telegram_init_data(init_data: str) -> bool:
        """
        Valida l'initData di Telegram Mini App usando HMAC-SHA256.
        
        Args:
            init_data: Dati init ricevuti dalla Mini App (formato query string)
            
        Returns:
            True se validi, False altrimenti
        """
        try:
            if not init_data:
                logger.warning("validate_telegram_init_data: initData is empty")
                return False

            data = parse_qs(init_data, keep_blank_values=True)
            hash_value = data.get('hash', [None])[0]
            if not hash_value:
                logger.warning("validate_telegram_init_data: no hash in initData")
                return False

            auth_data = {k: unquote(v[0]) for k, v in data.items() if k != 'hash'}

            sorted_data = sorted(auth_data.items())

            data_check_string = '\n'.join(f"{k}={v}" for k, v in sorted_data)

            logger.debug("validate_telegram_init_data: data_check_string length=%d", len(data_check_string))

            # Algoritmo Telegram WebApp:
            # secret_key = HMAC_SHA256("WebAppData", bot_token)
            # check_hash = HMAC_SHA256(secret_key, data_check_string)
            webapp_secret = hmac.new(
                b"WebAppData",
                settings.telegram_bot_token.encode("utf-8"),
                hashlib.sha256,
            ).digest()

            calculated_hash = hmac.new(
                webapp_secret,
                data_check_string.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()

            # Confronta gli hash in modo sicuro
            return hmac.compare_digest(calculated_hash, hash_value)
            
        except Exception as e:
            print(f"Errore validazione initData: {e}")
            return False
    
    @staticmethod
    def extract_user_from_init_data(init_data: str) -> Optional[Dict]:
        """
        Estrae i dati utente dall'initData validato.
        """
        try:
            data = parse_qs(init_data, keep_blank_values=True)
            user_data = data.get('user', [None])[0]
            if user_data:
                import json
                return json.loads(unquote(user_data))
            return None
        except Exception:
            return None
