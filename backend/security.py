import hmac
import hashlib
from urllib.parse import parse_qs, unquote
from typing import Dict, Optional
from config import settings


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
                return False

            pairs = [chunk for chunk in init_data.split('&') if chunk]
            raw_data = {}
            hash_value = None
            for pair in pairs:
                key, sep, value = pair.partition('=')
                if not sep:
                    continue
                if key == 'hash':
                    hash_value = value
                else:
                    raw_data[key] = value

            if not hash_value:
                return False

            sorted_data = sorted(raw_data.items())

            data_check_string = '\n'.join(f"{k}={v}" for k, v in sorted_data)

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
