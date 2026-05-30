import logging
import re
import pytesseract
import requests
from PIL import Image, ImageEnhance, ImageFilter
from typing import Optional
from config import settings

logger = logging.getLogger(__name__)

# --- Named constants ---
HIGH_CONFIDENCE_THRESHOLD = 0.85  # Early exit if confidence >= this
COMBINED_TEXT_FALLBACK_CONFIDENCE = 0.5
CROP_LEFT_PERCENT = 0.05
CROP_TOP_PERCENT = 0.25
CROP_RIGHT_PERCENT = 0.95
CROP_BOTTOM_PERCENT = 0.85
TARGET_WIDTH_PX = 1800  # Target width for upscaling
CONTRAST_FACTOR = 2.2
BINARIZE_THRESHOLD = 145
API_TIMEOUT_SECONDS = 30


class OCRResult:
    def __init__(self, plate: str, confidence: float):
        self.plate = plate
        self.confidence = confidence


class OCRService:
    """Servizio OCR isolato dietro interfaccia, sostituibile in futuro."""

    # Regex per targhe italiane standard e varianti speciali
    ITALIAN_PLATE_PATTERNS = [
        r'^[A-Z]{2}[0-9]{3}[A-Z]{2}$',  # Standard: AB123CD
        r'^[A-Z]{2}[0-9]{5}$',          # Vecchio formato: AB12345
        r'^[0-9]{7}$',                  # Ciclomotori: 1234567
        r'^[A-Z]{2}[0-9]{3}[A-Z]{1}$',  # Personalizzate: AB123C
    ]

    PLATE_RECOGNIZER_API_URL = "https://api.platerecognizer.com/v1/plate-reader/"

    @staticmethod
    def extract_plate_from_image(image_path: str) -> OCRResult:
        """
        Estrae la targa da un'immagine usando Tesseract OCR.

        Args:
            image_path: Path dell'immagine da analizzare

        Returns:
            OCRResult con targa rilevata e confidenza
        """
        try:
            api_result = OCRService._extract_with_plate_recognizer(image_path)
            if api_result and api_result.plate:
                logger.info("Plate detected via API: %s (confidence: %.2f)", api_result.plate, api_result.confidence)
                return api_result

            image = Image.open(image_path)
            candidates = OCRService._preprocess_images(image)
            configs = [
                r'--oem 3 --psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                r'--oem 3 --psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                r'--oem 3 --psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                r'--oem 3 --psm 11 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            ]

            best_plate = ""
            best_confidence = 0.0

            for candidate in candidates:
                for config in configs:
                    data = pytesseract.image_to_data(candidate, config=config, output_type=pytesseract.Output.DICT)
                    text_parts = []

                    for i, text in enumerate(data.get('text', [])):
                        clean_text = re.sub(r'[^A-Z0-9]', '', text.strip().upper())
                        if clean_text:
                            text_parts.append(clean_text)
                            plate = OCRService._extract_plate_from_text(clean_text)
                            if plate:
                                conf_list = data.get('conf', [])
                                raw_conf = conf_list[i] if i < len(conf_list) else 0
                                confidence = OCRService._safe_confidence(raw_conf)
                                if confidence >= best_confidence:
                                    best_plate = plate
                                    best_confidence = confidence
                                    # Early exit on high confidence
                                    if best_confidence >= HIGH_CONFIDENCE_THRESHOLD:
                                        logger.info("High-confidence plate found early: %s (%.2f)", best_plate, best_confidence)
                                        return OCRResult(best_plate, best_confidence)

                    combined_text = ''.join(text_parts)
                    plate = OCRService._extract_plate_from_text(combined_text)
                    if plate and best_confidence < COMBINED_TEXT_FALLBACK_CONFIDENCE:
                        best_plate = plate
                        best_confidence = COMBINED_TEXT_FALLBACK_CONFIDENCE

                # Early exit after processing a candidate if confidence is high enough
                if best_confidence >= HIGH_CONFIDENCE_THRESHOLD:
                    logger.info("High-confidence plate found: %s (%.2f)", best_plate, best_confidence)
                    return OCRResult(best_plate, best_confidence)

            if best_plate:
                logger.info("Plate detected via Tesseract: %s (confidence: %.2f)", best_plate, best_confidence)
                return OCRResult(best_plate, best_confidence)

            logger.info("No plate detected in image: %s", image_path)
            return OCRResult("", 0.0)

        except Exception as e:
            logger.error("OCR error for image %s: %s", image_path, e)
            return OCRResult("", 0.0)

    @staticmethod
    def _extract_with_plate_recognizer(image_path: str) -> Optional[OCRResult]:
        token = settings.plate_recognizer_token.strip()
        if not token:
            return None

        try:
            with open(image_path, "rb") as image_file:
                response = requests.post(
                    OCRService.PLATE_RECOGNIZER_API_URL,
                    files={"upload": image_file},
                    headers={"Authorization": f"Token {token}"},
                    timeout=API_TIMEOUT_SECONDS,
                )

            if not response.ok:
                logger.warning("Plate Recognizer error: %d %s", response.status_code, response.text)
                return None

            data = response.json()
            results = data.get("results", [])
            if not results:
                return None

            best_result = max(results, key=lambda item: item.get("score", 0))
            plate = re.sub(r'[^A-Z0-9]', '', best_result.get("plate", "").upper())
            confidence = float(best_result.get("score", 0))

            extracted_plate = OCRService._extract_plate_from_text(plate)
            if not extracted_plate:
                return None

            return OCRResult(extracted_plate, confidence)
        except requests.Timeout:
            logger.error("Plate Recognizer API timeout after %ds", API_TIMEOUT_SECONDS)
            return None
        except Exception as e:
            logger.error("Plate Recognizer error: %s", e)
            return None

    @staticmethod
    def _preprocess_images(image: Image.Image):
        if image.mode != 'RGB':
            image = image.convert('RGB')

        width, height = image.size

        # Skip crop if image is too small
        if width < 100 or height < 100:
            candidates_source = [image]
        else:
            center_crop = image.crop((
                int(width * CROP_LEFT_PERCENT),
                int(height * CROP_TOP_PERCENT),
                int(width * CROP_RIGHT_PERCENT),
                int(height * CROP_BOTTOM_PERCENT)
            ))
            candidates_source = [image, center_crop]

        processed = []
        for img in candidates_source:
            gray = img.convert('L')
            scale = max(1, min(3, TARGET_WIDTH_PX // max(1, gray.width)))
            if scale > 1:
                gray = gray.resize((gray.width * scale, gray.height * scale), Image.Resampling.LANCZOS)

            sharp = gray.filter(ImageFilter.SHARPEN)
            contrast = ImageEnhance.Contrast(sharp).enhance(CONTRAST_FACTOR)
            threshold = contrast.point(lambda pixel: 255 if pixel > BINARIZE_THRESHOLD else 0)

            processed.extend([gray, contrast, threshold])

        return processed

    @staticmethod
    def _extract_plate_from_text(text: str) -> Optional[str]:
        clean_text = re.sub(r'[^A-Z0-9]', '', text.upper())
        for length in range(7, 4, -1):
            for start in range(0, max(1, len(clean_text) - length + 1)):
                candidate = clean_text[start:start + length]
                if OCRService.validate_plate_format(candidate):
                    return candidate
        return None

    @staticmethod
    def _safe_confidence(confidence) -> float:
        try:
            value = float(confidence)
            if value < 0:
                return 0.0
            return min(value / 100.0, 1.0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def validate_plate_format(plate: str) -> bool:
        """
        Verifica se una targa ha un formato valido italiano.
        Usato come segnale aggiuntivo di validità, non come blocco.
        """
        plate = plate.strip().upper()
        for pattern in OCRService.ITALIAN_PLATE_PATTERNS:
            if re.match(pattern, plate):
                return True
        return False

    @staticmethod
    def should_use_fallback(ocr_result: OCRResult) -> bool:
        """
        Decide se usare il fallback manuale basandosi sulla confidenza.
        """
        return ocr_result.confidence < settings.ocr_confidence_threshold
