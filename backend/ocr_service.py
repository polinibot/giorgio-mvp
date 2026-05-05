import re
import pytesseract
from PIL import Image, ImageEnhance, ImageFilter
from typing import Optional
from config import settings


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
                                confidence = OCRService._safe_confidence(data.get('conf', [])[i])
                                if confidence >= best_confidence:
                                    best_plate = plate
                                    best_confidence = confidence
                    
                    combined_text = ''.join(text_parts)
                    plate = OCRService._extract_plate_from_text(combined_text)
                    if plate and best_confidence < 0.5:
                        best_plate = plate
                        best_confidence = 0.5
            
            if best_plate:
                return OCRResult(best_plate, best_confidence)
            
            return OCRResult("", 0.0)
                
        except Exception as e:
            print(f"Errore OCR: {e}")
            return OCRResult("", 0.0)
    
    @staticmethod
    def _preprocess_images(image: Image.Image):
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        width, height = image.size
        center_crop = image.crop((
            int(width * 0.05),
            int(height * 0.25),
            int(width * 0.95),
            int(height * 0.85)
        ))
        
        processed = []
        for img in (image, center_crop):
            gray = img.convert('L')
            scale = max(1, min(3, 1800 // max(1, gray.width)))
            if scale > 1:
                gray = gray.resize((gray.width * scale, gray.height * scale), Image.Resampling.LANCZOS)
            
            sharp = gray.filter(ImageFilter.SHARPEN)
            contrast = ImageEnhance.Contrast(sharp).enhance(2.2)
            threshold = contrast.point(lambda pixel: 255 if pixel > 145 else 0)
            
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
