"""Servizio per notificare errori su canale Telegram."""

import logging
import os
from typing import Optional

import aiohttp

from config import settings, ERROR_CHANNEL_ID

logger = logging.getLogger(__name__)


class ErrorNotifier:
    """Invia notifiche di errore con screenshot su canale Telegram."""

    def __init__(self):
        self.bot_token = settings.telegram_bot_token
        self.channel_id = ERROR_CHANNEL_ID
        self.base_url = f"https://api.telegram.org/bot{self.bot_token}"

    async def notify_error(
        self,
        error_message: str,
        stack_trace: Optional[str] = None,
        screenshot_path: Optional[str] = None,
        context: Optional[dict] = None,
    ) -> bool:
        """
        Invia notifica di errore su canale Telegram.

        Args:
            error_message: Messaggio di errore
            stack_trace: Stack trace opzionale
            screenshot_path: Path dello screenshot opzionale
            context: Dizionario con contesto aggiuntivo (es. practice_id, job_info)

        Returns:
            True se l'invio è riuscito, False altrimenti
        """
        self.bot_token = os.getenv("TELEGRAM_BOT_TOKEN", settings.telegram_bot_token)
        self.channel_id = os.getenv("TELEGRAM_ERROR_CHANNEL_ID", ERROR_CHANNEL_ID)
        self.base_url = f"https://api.telegram.org/bot{self.bot_token}"

        if not self.bot_token or not self.channel_id:
            logger.warning("Telegram bot token o channel ID non configurati. Notifica non inviata.")
            return False

        # Costruisci il messaggio
        text = self._format_message(error_message, stack_trace, context)

        try:
            if screenshot_path and os.path.exists(screenshot_path):
                # Invia foto con caption
                return await self._send_photo_with_caption(screenshot_path, text)
            else:
                # Invia solo testo
                return await self._send_message(text)
        except Exception as e:
            logger.error(f"Errore nell'invio notifica Telegram: {e}")
            return False

    @staticmethod
    def _escape_md(value) -> str:
        """Escape Telegram (legacy) Markdown control chars in inline text."""
        text = str(value if value is not None else "")
        for ch in ("\\", "`", "*", "_", "[", "]"):
            text = text.replace(ch, "\\" + ch)
        return text

    @staticmethod
    def _safe_code_block(value) -> str:
        """Neutralize content placed inside a ``` code block (backticks would
        otherwise terminate the block early)."""
        return str(value if value is not None else "").replace("`", "'")

    @staticmethod
    def _scrub_secrets(value) -> str:
        text = str(value if value is not None else "")
        sensitive_markers = ("TOKEN", "SECRET", "PASSWORD", "KEY", "DATABASE_URL", "COOKIE", "SESSION")
        for env_name, env_value in os.environ.items():
            if not env_value or len(env_value) < 8:
                continue
            if any(marker in env_name.upper() for marker in sensitive_markers):
                text = text.replace(env_value, f"[REDACTED:{env_name}]")
        return text

    def _format_message(
        self,
        error_message: str,
        stack_trace: Optional[str] = None,
        context: Optional[dict] = None,
    ) -> str:
        """Formatta il messaggio di errore per Telegram."""
        esc = self._escape_md
        lines = ["🚨 *Errore YAP Automation*"]

        if context:
            if context.get("practice_id"):
                lines.append(f"📋 Practice ID: `{esc(context['practice_id'])}`")
            if context.get("customer"):
                customer = context["customer"]
                lines.append(f"👤 Cliente: {esc(customer.get('name', 'N/A'))} ({esc(customer.get('plate', 'N/A'))})")
            if context.get("appointment"):
                appt = context["appointment"]
                lines.append(f"📅 Appuntamento: {esc(appt.get('date', 'N/A'))} {esc(appt.get('time', 'N/A'))}")
            if context.get("worker"):
                lines.append(f"🔧 Worker: `{esc(context['worker'])}`")

        safe_error = self._scrub_secrets(error_message)
        lines.append(f"\n❌ *Errore:*\n```\n{self._safe_code_block(safe_error[:500])}\n```")

        if stack_trace:
            safe_stack = self._scrub_secrets(stack_trace)
            truncated = safe_stack[:1500] if len(safe_stack) > 1500 else safe_stack
            lines.append(f"\n📄 *Stack Trace:*\n```\n{self._safe_code_block(truncated)}\n```")

        return "\n".join(lines)

    async def _send_message(self, text: str) -> bool:
        """Invia messaggio di testo su Telegram."""
        url = f"{self.base_url}/sendMessage"
        payload = {
            "chat_id": self.channel_id,
            "text": text,
            "parse_mode": "Markdown",
            "disable_notification": False,
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status == 200:
                    logger.info(f"Messaggio di errore inviato su canale {self.channel_id}")
                    return True
                else:
                    body = await response.text()
                    logger.error(f"Errore invio messaggio Telegram: {response.status} - {body}")
                    return False

    async def _send_photo_with_caption(self, photo_path: str, caption: str) -> bool:
        """Invia foto con caption su Telegram."""
        url = f"{self.base_url}/sendPhoto"

        try:
            # Leggi il file prima (modo sincrono) - evita problemi async context manager
            with open(photo_path, "rb") as f:
                file_content = f.read()

            # Trunca caption se troppo lunga per le foto (max 1024 caratteri)
            truncated_caption = caption[:1000] + "\n... (truncated)" if len(caption) > 1024 else caption

            data = aiohttp.FormData()
            data.add_field("chat_id", self.channel_id)
            data.add_field("photo", file_content, filename=os.path.basename(photo_path))
            data.add_field("caption", truncated_caption)
            data.add_field("parse_mode", "Markdown")
            data.add_field("disable_notification", "false")

            async with aiohttp.ClientSession() as session:
                async with session.post(url, data=data) as response:
                        if response.status == 200:
                            logger.info(f"Screenshot errore inviato su canale {self.channel_id}")
                            return True
                        else:
                            body = await response.text()
                            logger.error(f"Errore invio foto Telegram: {response.status} - {body}")
                            # Prova a inviare solo il testo
                            return await self._send_message(caption)
        except Exception as e:
            logger.error(f"Errore nel send_photo: {e}")
            # Fallback a messaggio testo
            return await self._send_message(caption)


# Singleton instance
_error_notifier: Optional[ErrorNotifier] = None


def get_error_notifier() -> ErrorNotifier:
    """Restituisce l'istanza singleton del notificatore errori."""
    global _error_notifier
    if _error_notifier is None:
        _error_notifier = ErrorNotifier()
    return _error_notifier


async def notify_yap_error(
    error: Exception,
    screenshot_path: Optional[str] = None,
    context: Optional[dict] = None,
) -> bool:
    """
    Helper function per notificare errori YAP.

    Args:
        error: Eccezione da notificare
        screenshot_path: Path dello screenshot opzionale
        context: Contesto aggiuntivo

    Returns:
        True se l'invio è riuscito
    """
    notifier = get_error_notifier()
    return await notifier.notify_error(
        error_message=str(error),
        stack_trace=getattr(error, "__traceback__", None) and __import__("traceback").format_exc(),
        screenshot_path=screenshot_path,
        context=context,
    )
