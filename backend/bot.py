import asyncio
import logging
import os
from datetime import datetime
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.enums import ParseMode
from sqlalchemy.orm import Session

from config import settings
from database_sqlite import get_db, create_tables, Practice, PracticePhoto, PracticeStatus, PracticeType, CustomerType
from ocr_service import OCRService, OCRResult
from security import SecurityService
from models import PracticeDraft
from cloudinary_service import cloudinary_service

logger = logging.getLogger(__name__)

# Valid image extensions for validation
VALID_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff'}


class TelegramBot:
    def __init__(self):
        self.bot = Bot(token=settings.telegram_bot_token)
        self.dp = Dispatcher()
        self.user_states = {}  # Stato per input manuale targa
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

    def setup_handlers(self):
        """Configura tutti gli handler del bot"""

        @self.dp.message(Command("start"))
        async def cmd_start(message: Message):
            """Handler per il comando /start"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            await message.answer(
                "👋 Benvenuto nel bot Giorgio!\n\n"
                "📸 Invia una foto della targa o del veicolo per iniziare una nuova pratica."
            )

        @self.dp.callback_query(F.data == "new_practice")
        async def callback_new_practice(callback: CallbackQuery):
            """Handler per il pulsante Nuova pratica"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return

            await callback.message.answer(
                "📸 Invia una foto della targa o del veicolo:\n\n"
                "Il sistema rileverà automaticamente la targa.\n"
                "Se la confidenza è bassa, ti chiederò di inserirla manualmente."
            )
            await callback.answer()

        @self.dp.message(F.photo)
        async def handle_photo(message: Message):
            """Handler per la ricezione di foto"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            progress_message = None
            try:
                progress_message = await message.answer("🔄 Analizzo la foto, attendi un attimo...")
                # Scarica la foto
                photo = message.photo[-1]  # Prendi la risoluzione più alta
                file_info = await self.bot.get_file(photo.file_id)
                file_path = file_info.file_path

                # Crea directory se non esiste
                os.makedirs("storage/photos", exist_ok=True)

                # Scarica e salva localmente
                downloaded_file = await self.bot.download_file(file_path)
                local_path = f"storage/photos/{photo.file_id}.jpg"

                await asyncio.to_thread(self._write_file, local_path, downloaded_file.getvalue())

                # Validate that downloaded file is a valid image
                try:
                    await asyncio.to_thread(self._verify_image, local_path)
                except Exception as img_err:
                    logger.warning("Downloaded file is not a valid image: %s", img_err)
                    await message.answer("❌ Il file ricevuto non è un'immagine valida. Riprova con una foto.")
                    if progress_message:
                        await progress_message.delete()
                    return

                # OCR with error handling
                try:
                    ocr_result = await asyncio.to_thread(OCRService.extract_plate_from_image, local_path)
                except Exception as ocr_err:
                    logger.error("OCR processing failed: %s", ocr_err)
                    ocr_result = OCRResult("", 0.0)
                    await message.answer("⚠️ Errore durante il riconoscimento targa. Puoi inserirla manualmente.")

                db = next(get_db())
                try:
                    practice = Practice(
                        created_by_telegram_id=message.from_user.id,
                        status=PracticeStatus.DRAFT,
                        plate_detected=ocr_result.plate,
                        plate_confirmed=ocr_result.plate if ocr_result.plate else None,
                        phone=None,
                        customer_name=None,
                        customer_type=CustomerType.PRIVATO,
                        appointment_date=datetime.utcnow(),
                        appointment_time="09:00",
                        practice_type=PracticeType.PREVENTIVO,
                        contexts="officina"
                    )
                    db.add(practice)
                    db.commit()
                    db.refresh(practice)

                    try:
                        storage_path, _ = await asyncio.to_thread(
                            cloudinary_service.upload_practice_photo,
                            local_path,
                            practice.id,
                            photo.file_id
                        )
                    except Exception as upload_err:
                        logger.warning("Cloudinary upload failed, using local path: %s", upload_err)
                        storage_path = local_path

                    photo_record = PracticePhoto(
                        practice_id=practice.id,
                        telegram_file_id=photo.file_id,
                        storage_path=storage_path,
                        ocr_result=ocr_result.plate,
                        ocr_confidence=ocr_result.confidence
                    )
                    db.add(photo_record)
                    db.commit()

                    await self.send_plate_confirmation(
                        message,
                        practice.id,
                        photo.file_id,
                        ocr_result,
                        local_path
                    )
                    if progress_message:
                        await progress_message.delete()
                finally:
                    db.close()

            except Exception as e:
                logger.error("Error handling photo from user %d: %s", message.from_user.id, e)
                await message.answer("❌ Errore durante l'elaborazione della foto. Riprova.")
                if progress_message:
                    try:
                        await progress_message.delete()
                    except Exception:
                        pass

        @self.dp.callback_query(F.data.startswith("plate_"))
        async def handle_plate_action(callback: CallbackQuery):
            """Handler per le azioni sulla targa"""
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

        @self.dp.callback_query(F.data.startswith("edit_practice_"))
        async def handle_edit_practice(callback: CallbackQuery):
            """Handler per modifica pratica esistente"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return

            practice_id = int(callback.data.split("_")[2])

            access_token = SecurityService.generate_practice_access_token(practice_id, callback.from_user.id)
            # Crea Mini App URL per modifica
            mini_app_url = f"https://giorgio-mvp-nine.vercel.app?practice_id={practice_id}&user_id={callback.from_user.id}&access_token={access_token}"

            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(
                    text="📝 Modifica pratica",
                    web_app=WebAppInfo(url=mini_app_url)
                )]
            ])

            await callback.message.answer(
                f"✏️ Modifica pratica #{practice_id}\n\n"
                f"Premi il pulsante sotto per modificare i dati:",
                reply_markup=keyboard,
                parse_mode=ParseMode.HTML
            )

            await callback.answer()

        @self.dp.callback_query(F.data.startswith("summary_practice_"))
        async def handle_summary_practice(callback: CallbackQuery):
            """Handler per riepilogo pratica"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return

            practice_id = int(callback.data.split("_")[2])

            try:
                from telegram_utils import TelegramFormatter, build_practice_summary
                db = next(get_db())
                try:
                    summary = build_practice_summary(db, practice_id, callback.from_user.id)
                finally:
                    db.close()
                text = TelegramFormatter.format_practice_summary(summary)
                keyboard = TelegramFormatter.create_practice_keyboard(practice_id)
                await callback.message.answer(
                    text,
                    reply_markup=InlineKeyboardMarkup(**keyboard),
                    parse_mode=ParseMode.HTML
                )
            except Exception as e:
                logger.error("Error loading practice summary %d: %s", practice_id, e)
                await callback.message.answer("âŒ Errore caricamento riepilogo")
            await callback.answer()
            return

            # Ottieni riepilogo dall'API
            try:
                raise RuntimeError("Unreachable legacy API summary path")

                if response.status_code == 200:
                    data = response.json()
                    if data["success"]:
                        from telegram_utils import TelegramFormatter
                        summary = data["data"]

                        # Formatta riepilogo
                        from models import PracticeSummary
                        practice_summary = PracticeSummary(**summary)
                        text = TelegramFormatter.format_practice_summary(practice_summary)

                        # Tastiera azioni
                        keyboard = TelegramFormatter.create_practice_keyboard(practice_id)

                        await callback.message.answer(
                            text,
                            reply_markup=keyboard,
                            parse_mode=ParseMode.HTML
                        )
                    else:
                        await callback.message.answer("❌ Errore caricamento riepilogo")
                else:
                    await callback.message.answer("❌ Pratica non trovata")

            except Exception as e:
                logger.error("Error loading practice summary %d: %s", practice_id, e)
                await callback.message.answer("❌ Errore caricamento riepilogo")

            await callback.answer()

        @self.dp.message(F.text)
        async def handle_text_input(message: Message):
            """Handler per input testuali (modifica manuale targa)"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return

            user_id = message.from_user.id
            text = message.text.strip().upper()

            # Controlla se utente è in stato di inserimento targa
            if user_id in self.user_states and self.user_states[user_id]['action'] == 'waiting_plate':
                practice_id = self.user_states[user_id]['practice_id']

                # Valida formato targa base
                if len(text) < 5 or len(text) > 10:
                    await message.answer("❌ Formato targa non valido. Riprova (es. AB123CD):")
                    return

                # Aggiorna pratica con la targa inserita manualmente
                db = next(get_db())
                try:
                    practice = db.query(Practice).filter(Practice.id == practice_id).first()
                    if practice:
                        practice.plate_confirmed = text
                        db.commit()

                        # Rimuovi stato
                        del self.user_states[user_id]

                        # Apri Mini App senza sovrascrivere la targa manuale
                        await self.confirm_plate_and_open_form(message, practice_id, override_from_detected=False)
                    else:
                        await message.answer("❌ Pratica non trovata")

                finally:
                    db.close()
            else:
                # Messaggio non riconosciuto
                await message.answer("❌ Comando non riconosciuto. Usa /start per iniziare.")

    async def send_plate_confirmation(self, message: Message, practice_id: int, file_id: str, ocr_result: OCRResult, photo_path: str):
        """Invia messaggio di conferma targa con opzioni"""
        should_fallback = OCRService.should_use_fallback(ocr_result)

        # Costruisci il testo del messaggio
        if ocr_result.plate and not should_fallback:
            text = (
                f"🔍 Targa rilevata: <b>{ocr_result.plate}</b>\n\n"
                f"La targa è corretta?"
            )

            # Se la confidenza è bassa, aggiungi avviso
            if OCRService.should_use_fallback(ocr_result):
                text += "\n⚠️ La confidenza è bassa, verifica attentamente."
        else:
            text = (
                f"❌ Non sono riuscito a rilevare una targa.\n\n"
                f"Vuoi inserirla manualmente o riprovare con un'altra foto?"
            )

        # Costruisci la tastiera inline
        if ocr_result.plate and not should_fallback:
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [
                    InlineKeyboardButton(text="✅ Conferma", callback_data=f"plate_confirm_{practice_id}"),
                    InlineKeyboardButton(text="✏️ Modifica", callback_data=f"plate_edit_{practice_id}")
                ],
                [
                    InlineKeyboardButton(text="🔄 Riprova con altra foto", callback_data=f"plate_retry_{practice_id}")
                ]
            ])
        else:
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [
                    InlineKeyboardButton(text="✏️ Inserisci targa manualmente", callback_data=f"plate_edit_{practice_id}"),
                    InlineKeyboardButton(text="🔄 Riprova con altra foto", callback_data=f"plate_retry_{practice_id}")
                ]
            ])

        # Invia solo il testo (l'utente ha già la foto)
        await message.answer(
            text,
            reply_markup=keyboard,
            parse_mode=ParseMode.HTML
        )

    async def confirm_plate_and_open_form(self, source: Message | CallbackQuery, practice_id: int, override_from_detected: bool = True):
        """Conferma (opzionale) la targa rilevata e apre la Mini App con form precompilato."""
        db = next(get_db())
        try:
            practice = db.query(Practice).filter(Practice.id == practice_id).first()
            if not practice:
                if isinstance(source, CallbackQuery):
                    await source.message.answer("❌ Pratica non trovata")
                else:
                    await source.answer("❌ Pratica non trovata")
                return

            # Solo nel caso di conferma automatica sovrascriviamo da plate_detected
            if override_from_detected and practice.plate_detected:
                practice.plate_confirmed = practice.plate_detected
                db.commit()

            # Determina target messaggio e utente Telegram
            if isinstance(source, CallbackQuery):
                message_target = source.message
                from_user_id = source.from_user.id
            else:
                message_target = source
                from_user_id = source.from_user.id

            access_token = SecurityService.generate_practice_access_token(practice_id, from_user_id)
            # Crea Mini App button con dati precompilati
            mini_app_url = f"https://giorgio-mvp-nine.vercel.app?practice_id={practice_id}&plate={practice.plate_confirmed}&user_id={from_user_id}&access_token={access_token}"

            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(
                    text="📝 Compila dati pratica",
                    web_app=WebAppInfo(url=mini_app_url)
                )]
            ])

            await message_target.answer(
                f"✅ Targa confermata: <b>{practice.plate_confirmed}</b>\n\n"
                f"Premi il pulsante sotto per compilare i dati della pratica:",
                reply_markup=keyboard,
                parse_mode=ParseMode.HTML
            )

            # Aggiungi pulsante "Nuova pratica" alla fine del flusso
            new_practice_keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🆕 Nuova pratica", callback_data="new_practice")]
            ])
            await message_target.answer(
                "Hai completato questa pratica? Puoi iniziarne un'altra:",
                reply_markup=new_practice_keyboard
            )

        except Exception as e:
            logger.error("Error confirming plate for practice %d: %s", practice_id, e)
            if isinstance(source, CallbackQuery):
                await source.message.answer("❌ Errore durante la conferma. Riprova.")
            else:
                await source.answer("❌ Errore durante la conferma. Riprova.")
        finally:
            db.close()

    async def request_manual_plate(self, callback: CallbackQuery, practice_id: int):
        """Richiede l'inserimento manuale della targa"""
        # Imposta stato utente per attendere input
        self.user_states[callback.from_user.id] = {
            'action': 'waiting_plate',
            'practice_id': practice_id
        }

        await callback.message.answer(
            "✏️ Inserisci la targa manualmente:\n\n"
            "Formato atteso: AB123CD\n"
            "Scrivila in chat e premi Invio."
        )

    async def request_new_photo(self, callback: CallbackQuery, practice_id: int):
        """Richiede una nuova foto"""
        # Imposta stato utente per attendere nuova foto
        self.user_states[callback.from_user.id] = {
            'action': 'waiting_photo',
            'practice_id': practice_id
        }

        await callback.message.answer(
            "📸 Invia una nuova foto della targa o del veicolo:"
        )

    async def start(self):
        """Avvia il bot"""
        logger.info("Starting Telegram bot...")
        await self.bot.delete_webhook(drop_pending_updates=True)
        await self.dp.start_polling(self.bot)


# Funzione per avviare il bot
async def start_bot():
    create_tables()
    bot_instance = TelegramBot()
    await bot_instance.start()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(start_bot())
