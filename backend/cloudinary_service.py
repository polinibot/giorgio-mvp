import logging
import cloudinary
import cloudinary.uploader
import cloudinary.api
from PIL import Image
import io
import os
from typing import Tuple, Optional
from config import settings

logger = logging.getLogger(__name__)

# Target max dimensions for compression
MAX_WIDTH = 1920
MAX_HEIGHT = 1080


class CloudinaryService:
    """Servizio Cloudinary con compressione ottimizzata per foto targhe"""

    def __init__(self):
        # Configura Cloudinary
        cloudinary.config(
            cloud_name=settings.cloudinary_cloud_name,
            api_key=settings.cloudinary_api_key,
            api_secret=settings.cloudinary_api_secret
        )

    def compress_image(self, image_path: str, quality: int = 80) -> bytes:
        """
        Comprime immagine prima dell'upload su Cloudinary.

        Args:
            image_path: Path dell'immagine originale
            quality: Qualità compressione (1-100)

        Returns:
            Image compressa in bytes
        """
        try:
            with Image.open(image_path) as img:
                # Validate image
                img.verify()

            # Re-open after verify (verify closes the image)
            with Image.open(image_path) as img:
                # Converti in RGB se necessario (per JPEG/WebP)
                if img.mode in ('RGBA', 'LA', 'P'):
                    img = img.convert('RGB')

                # Smart resize: skip if already smaller than target
                width, height = img.size
                if width > MAX_WIDTH or height > MAX_HEIGHT:
                    img.thumbnail((MAX_WIDTH, MAX_HEIGHT), Image.Resampling.LANCZOS)
                    logger.info("Image resized from %dx%d to %dx%d", width, height, img.width, img.height)
                else:
                    logger.info("Image already within target dimensions (%dx%d), skipping resize", width, height)

                # Salva in memoria con compressione
                compressed_buffer = io.BytesIO()
                img.save(compressed_buffer, format='WEBP', quality=quality, optimize=True)
                compressed_buffer.seek(0)

                return compressed_buffer.getvalue()

        except (IOError, OSError, SyntaxError) as e:
            logger.error("Invalid image data at %s: %s", image_path, e)
            raise ValueError(f"Invalid image file: {image_path}") from e
        except Exception as e:
            logger.error("Error compressing image %s: %s", image_path, e)
            # Fallback: immagine originale
            with open(image_path, 'rb') as f:
                return f.read()

    def upload_practice_photo(self, image_path: str, practice_id: int, telegram_file_id: str) -> Tuple[str, dict]:
        """
        Upload foto pratica su Cloudinary con compressione.

        Args:
            image_path: Path foto locale
            practice_id: ID pratica
            telegram_file_id: ID file Telegram

        Returns:
            Tuple (URL, metadata upload)
        """
        try:
            # Comprimi immagine
            compressed_image = self.compress_image(image_path, quality=80)

            # Upload su Cloudinary con trasformazioni
            result = cloudinary.uploader.upload(
                compressed_image,
                folder=f"giorgio/practices/{practice_id}",
                public_id=f"photo_{telegram_file_id}",
                format="webp",
                resource_type="image",
                quality="auto:good",
                fetch_format="auto",
                eager=[
                    {"width": 800, "crop": "limit", "quality": "auto:good"},
                    {"width": 400, "crop": "limit", "quality": "auto:good"}  # Thumbnail
                ]
            )

            logger.info("Photo uploaded to Cloudinary: practice=%d, url=%s", practice_id, result['secure_url'])
            return result['secure_url'], result

        except ValueError:
            # Invalid image - re-raise
            raise
        except Exception as e:
            logger.error("Cloudinary upload error for practice %d: %s", practice_id, e)
            raise

    def get_optimized_url(self, base_url: str, width: int = 800, quality: str = "auto:good") -> str:
        """
        Genera URL ottimizzato da Cloudinary.

        Args:
            base_url: URL base Cloudinary
            width: Larghezza desiderata
            quality: Qualità automatica

        Returns:
            URL ottimizzato
        """
        try:
            if '/upload/' in base_url:
                optimized_url = base_url.replace(
                    '/upload/',
                    f'/upload/q_{quality},w_{width},c_limit,f_auto/'
                )
                return optimized_url
            return base_url
        except Exception:
            return base_url

    def get_thumbnail_url(self, base_url: str, width: int = 200) -> str:
        """
        Genera URL thumbnail.

        Args:
            base_url: URL base Cloudinary
            width: Larghezza thumbnail

        Returns:
            URL thumbnail
        """
        return self.get_optimized_url(base_url, width=width, quality="auto:good")

    def delete_photo(self, public_id: str) -> bool:
        """
        Cancella foto da Cloudinary.

        Args:
            public_id: ID pubblico della risorsa

        Returns:
            True se cancellato con successo
        """
        try:
            result = cloudinary.api.delete_resources([public_id], resource_type="image")
            deleted = result.get('deleted', {}).get(public_id) == 'deleted'
            if deleted:
                logger.info("Photo deleted from Cloudinary: %s", public_id)
            else:
                logger.warning("Photo deletion returned unexpected result for: %s", public_id)
            return deleted
        except Exception as e:
            logger.error("Cloudinary deletion error for %s: %s", public_id, e)
            return False

    def get_storage_info(self) -> dict:
        """
        Ottiene informazioni storage da Cloudinary.

        Returns:
            Info su utilizzo storage
        """
        try:
            result = cloudinary.api.usage()
            return {
                "storage_used": result.get("storage", {}).get("used", 0),
                "storage_limit": result.get("storage", {}).get("limit", 0),
                "bandwidth_used": result.get("bandwidth", {}).get("used", 0),
                "bandwidth_limit": result.get("bandwidth", {}).get("limit", 0)
            }
        except Exception as e:
            logger.error("Error fetching Cloudinary storage info: %s", e)
            return {}


# Istanza globale del servizio
cloudinary_service = CloudinaryService()
