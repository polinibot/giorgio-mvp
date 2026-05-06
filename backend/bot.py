import asyncio
import logging
import os
from datetime import datetime

from aiogram import Bot, Dispatcher, F
from aiogram.enums import ParseMode
from aiogram.filters import Command
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

from cloudinary_service import cloudinary_service
from config import settings
from database_sqlite import (
    Practice,
    PracticePhoto,
    PracticeStatus,
    PracticeType,
    CustomerType,
    create_tables,
    get_db,
)
from ocr_service import OCRResult, OCRService
from security import SecurityService

logger = logging.getLogger(__name__)


class TelegramBot:
    def __init__(self):
        self.bot = Bot(token=settings.telegram_bot_token)
        self.dp = Dispatcher()
        self.user_states = {}
        self.setup_handlers()

    @staticmethod
    def _write_file(path: str, content: bytes):
        with open(path, "wb") as f:
            f.write(content)

    @staticmethod
    def _verify_image(path: str):
        from PIL import Image

        with Image.open(path) as img:
            img.verify()

    @staticmethod
    def _base_start_message() -> str:
        return (
            "📸 Invia una foto della targa o del veicolo.\n\n"
            "Ti faccio confermare la targa e poi apri direttamente la Mini App."
        )

    def setup_handlers(self):
        """Configura il flusso Telegram minimale: foto -> targa -> Mini App."""

        @self.dp.message(Command("start"))
        async def cmd_start(message: Message):
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            await message.answer(self._base_start_message())

        @self.dp.message(F.photo)
        async def handle_photo(message: Message):
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            progress_message = None
            try:
                progress_message = await message.answer("🔄 Analizzo la foto, attendi un attimo...")

                photo = message.photo[-1]
                file_info = await self.bot.get_file(photo.file_id)
                file_path = file_info.file_path

                os.makedirs("storage/photos", exist_ok=True)

                downloaded_file = await self.bot.download_file(file_path)
                local_path = f"storage/photos/{photo.file_id}.jpg"
                await asyncio.to_thread(self._write_file, local_path, downloaded_file.getvalue())

                try:
                    await asyncio.to_thread(self._verify_image, local_path)
                except Exception as img_err:
                    logger.warning("Downloaded file is not a valid image: %s", img_err)
                    await message.answer("❌ Il file ricevuto non è un'immagine valida. Riprova con una foto.")
                    if progress_message:
                        await progress_message.delete()
                    return

                try:
                    ocr_result = await asyncio.to_thread(OCRService.extract_plate_from_image, local_path)
                except Exception as ocr_err:
                    logger.error("OCR processing failed: %s", ocr_err)
                    ocr_result = OCRResult("", 0.0)
                    await message.answer("⚠️ Errore durante il riconoscimento targa. Puoi inserirla manualmente.")

                user_state = self.user_states.get(message.from_user.id)
                retry_practice_id = None
                if user_state and user_state.get("action") == "waiting_photo":
                    retry_practice_id = user_state.get("practice_id")

                db = next(get_db())
                try:
                    practice = self._save_or_update_draft_practice(
                        db=db,
                        telegram_user_id=message.from_user.id,
                        practice_id=retry_practice_id,
                        photo_file_id=photo.file_id,
                        local_path=local_path,
                        ocr_result=ocr_result,
                    )

                    self.user_states.pop(message.from_user.id, None)

                    await self.send_plate_confirmation(
                        message=message,
                        practice_id=practice.id,
                        ocr_result=ocr_result,
                    )
                finally:
                    db.close()

                if progress_message:
                    await progress_message.delete()

            except Exception as e:
                logger.error("Error handling photo from user %d: %s", message.from_user.id, e, exc_info=True)
                await message.answer("❌ Errore durante l'elaborazione della foto. Riprova.")
                if progress_message:
                    try:
                        await progress_message.delete()
                    except Exception:
                        pass

        @self.dp.callback_query(F.data.startswith("plate_"))
        async def handle_plate_action(callback: CallbackQuery):
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return

            action_data = callback.data.split("_")
            action = action_data[1]
            practice_id = int(action_data[2])

            if action == "confirm":
                await self.confirm_plate_and_open_form(callback, practice_id)
            elif action == "edit":
                await self.request_manual_plate(callback, practice_id)
            elif action == "retry":
                await self.request_new_photo(callback, practice_id)

            await callback.answer()

        @self.dp.message(F.text)
        async def handle_text_input(message: Message):
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            user_id = message.from_user.id
            text = message.text.strip().upper()
            user_state = self.user_states.get(user_id)

            if user_state and user_state.get("action") == "waiting_plate":
                practice_id = user_state["practice_id"]

                if len(text) < 5 or len(text) > 10:
                    await message.answer("❌ Formato targa non valido. Riprova (es. AB123CD):")
                    return

                db = next(get_db())
                try:
                    practice = db.query(Practice).filter(Practice.id == practice_id).first()
                    if practice:
                        practice.plate_confirmed = text
                        db.commit()
                        self.user_states.pop(user_id, None)
                        await self.confirm_plate_and_open_form(
                            message,
                            practice_id,
                            override_from_detected=False,
                        )
                    else:
                        await message.answer("❌ Pratica non trovata")
                finally:
                    db.close()
            else:
                await message.answer(self._base_start_message())

    def _save_or_update_draft_practice(
        self,
        db,
        telegram_user_id: int,
        practice_id: int | None,
        photo_file_id: str,
        local_path: str,
        ocr_result: OCRResult,
    ) -> Practice:
        practice = None
        if practice_id:
            practice = db.query(Practice).filter(Practice.id == practice_id).first()

        if practice is None:
            practice = Practice(
                created_by_telegram_id=telegram_user_id,
                status=PracticeStatus.DRAFT,
                customer_type=CustomerType.PRIVATO,
                appointment_date=datetime.utcnow(),
                appointment_time="09:00",
                practice_type=PracticeType.PREVENTIVO,
                contexts="officina",
            )
            db.add(practice)
            db.commit()
            db.refresh(practice)

        practice.created_by_telegram_id = telegram_user_id
        practice.updated_by_telegram_id = telegram_user_id
        practice.status = PracticeStatus.DRAFT
        practice.plate_detected = ocr_result.plate
        practice.plate_confirmed = ocr_result.plate if ocr_result.plate else None
        db.commit()
        db.refresh(practice)

        try:
            storage_path, _ = cloudinary_service.upload_practice_photo(
                local_path,
                practice.id,
                photo_file_id,
            )
        except Exception as upload_err:
            logger.warning("Cloudinary upload failed, using local path: %s", upload_err)
            storage_path = local_path

        db.query(PracticePhoto).filter(PracticePhoto.practice_id == practice.id).delete()
        photo_record = PracticePhoto(
            practice_id=practice.id,
            telegram_file_id=photo_file_id,
            storage_path=storage_path,
            ocr_result=ocr_result.plate,
            ocr_confidence=ocr_result.confidence,
        )
        db.add(photo_record)
        db.commit()
        db.refresh(practice)
        return practice

    async def send_plate_confirmation(self, message: Message, practice_id: int, ocr_result: OCRResult):
        should_fallback = OCRService.should_use_fallback(ocr_result)

        if ocr_result.plate and not should_fallback:
            text = f"🔍 Targa rilevata: <b>{ocr_result.plate}</b>\n\nConfermi la targa?"
        else:
            text = (
                "❌ Non sono riuscito a rilevare una targa.\n\n"
                "Inseriscila manualmente o riprova con un'altra foto."
            )

        if ocr_result.plate and not should_fallback:
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(text="✅ Conferma", callback_data=f"plate_confirm_{practice_id}"),
                        InlineKeyboardButton(text="✏️ Modifica", callback_data=f"plate_edit_{practice_id}"),
                    ],
                    [
                        InlineKeyboardButton(
                            text="🔄 Riprova con altra foto",
                            callback_data=f"plate_retry_{practice_id}",
                        )
                    ],
                ]
            )
        else:
            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(text="✏️ Inserisci targa", callback_data=f"plate_edit_{practice_id}"),
                        InlineKeyboardButton(
                            text="🔄 Riprova con altra foto",
                            callback_data=f"plate_retry_{practice_id}",
                        ),
                    ]
                ]
            )

        await message.answer(text, reply_markup=keyboard, parse_mode=ParseMode.HTML)

    async def confirm_plate_and_open_form(
        self,
        source: Message | CallbackQuery,
        practice_id: int,
        override_from_detected: bool = True,
    ):
        db = next(get_db())
        try:
            practice = db.query(Practice).filter(Practice.id == practice_id).first()
            if not practice:
                if isinstance(source, CallbackQuery):
                    await source.message.answer("❌ Pratica non trovata")
                else:
                    await source.answer("❌ Pratica non trovata")
                return

            if override_from_detected and practice.plate_detected:
                practice.plate_confirmed = practice.plate_detected
                db.commit()

            if isinstance(source, CallbackQuery):
                message_target = source.message
                from_user_id = source.from_user.id
            else:
                message_target = source
                from_user_id = source.from_user.id

            access_token = SecurityService.generate_practice_access_token(practice_id, from_user_id)
            mini_app_url = (
                "https://giorgio-mvp-nine.vercel.app"
                f"?practice_id={practice_id}"
                f"&plate={practice.plate_confirmed}"
                f"&user_id={from_user_id}"
                f"&access_token={access_token}"
            )

            keyboard = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="📱 Apri Mini App",
                            web_app=WebAppInfo(url=mini_app_url),
                        )
                    ]
                ]
            )

            await message_target.answer(
                f"✅ Targa confermata: <b>{practice.plate_confirmed}</b>\n\n"
                "Apri la Mini App per completare la pratica.",
                reply_markup=keyboard,
                parse_mode=ParseMode.HTML,
            )
        except Exception as e:
            logger.error("Error confirming plate for practice %d: %s", practice_id, e, exc_info=True)
            if isinstance(source, CallbackQuery):
                await source.message.answer("❌ Errore durante la conferma. Riprova.")
            else:
                await source.answer("❌ Errore durante la conferma. Riprova.")
        finally:
            db.close()

    async def request_manual_plate(self, callback: CallbackQuery, practice_id: int):
        self.user_states[callback.from_user.id] = {
            "action": "waiting_plate",
            "practice_id": practice_id,
        }

        await callback.message.answer(
            "✏️ Inserisci la targa manualmente:\n\n"
            "Formato atteso: AB123CD\n"
            "Scrivila in chat e premi Invio."
        )

    async def request_new_photo(self, callback: CallbackQuery, practice_id: int):
        self.user_states[callback.from_user.id] = {
            "action": "waiting_photo",
            "practice_id": practice_id,
        }

        await callback.message.answer("📸 Invia una nuova foto della targa o del veicolo.")

    async def start(self):
        logger.info("Starting Telegram bot...")
        await self.bot.delete_webhook(drop_pending_updates=True)
        await self.dp.start_polling(self.bot)


async def start_bot():
    create_tables()
    bot_instance = TelegramBot()
    await bot_instance.start()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_bot())
