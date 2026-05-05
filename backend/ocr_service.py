import re
import pytesseract
from PIL import Image
from typing import Tuple, Optional
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
            # Carica l'immagine
            image = Image.open(image_path)
            
            # Configurazione Tesseract per ottimizzare il riconoscimento targhe
            custom_config = r'--oem 3 --psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
            
            # Estrai testo e dati di confidenza
            data = pytesseract.image_to_data(image, config=custom_config, output_type=pytesseract.Output.DICT)
            
            # Filtra e pulisci i risultati
            plates = []
            confidences = []
            
            for i, text in enumerate(data['text']):
                text = text.strip().upper()
                if text and len(text) >= 5:  # Le targhe hanno almeno 5 caratteri
                    # Rimuovi spazi e caratteri non validi
                    clean_text = re.sub(r'[^A-Z0-9]', '', text)
                    
                    # Verifica se corrisponde a un pattern di targa italiana
                    for pattern in OCRService.ITALIAN_PLATE_PATTERNS:
                        if re.match(pattern, clean_text):
                            plates.append(clean_text)
                            confidences.append(float(data['conf'][i]))
                            break
            
            if plates:
                # Prendi la targa con confidenza più alta
                best_idx = confidences.index(max(confidences))
                return OCRResult(plates[best_idx], confidences[best_idx] / 100.0)
            else:
                # Nessuna targa trovata, restituisci risultato vuoto
                return OCRResult("", 0.0)
                
        except Exception as e:
            print(f"Errore OCR: {e}")
            return OCRResult("", 0.0)
    
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
