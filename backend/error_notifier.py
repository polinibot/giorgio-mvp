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

    def _format_message(
        self,
        error_message: str,
        stack_trace: Optional[str] = None,
        context: Optional[dict] = None,
    ) -> str:
        """Formatta il messaggio di errore per Telegram."""
        lines = ["🚨 *Errore YAP Automation*"]

        if context:
            if context.get("practice_id"):
                lines.append(f"📋 Practice ID: `{context['practice_id']}`")
            if context.get("customer"):
                customer = context["customer"]
                lines.append(f"👤 Cliente: {customer.get('name', 'N/A')} ({customer.get('plate', 'N/A')})")
            if context.get("appointment"):
                appt = context["appointment"]
                lines.append(f"📅 Appuntamento: {appt.get('date', 'N/A')} {appt.get('time', 'N/A')}")
            if context.get("worker"):
                lines.append(f"🔧 Worker: `{context['worker']}`")

        lines.append(f"\n❌ *Errore:*\n```\n{error_message[:500]}\n```")

        if stack_trace:
            truncated = stack_trace[:1500] if len(stack_trace) > 1500 else stack_trace
            lines.append(f"\n📄 *Stack Trace:*\n```\n{truncated}\n```")

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
