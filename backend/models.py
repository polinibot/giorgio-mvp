import re
from pydantic import BaseModel, Field, field_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


class PracticeStatus(str, Enum):
    DRAFT = "draft"
    CONFIRMED = "confirmed"
    DELETED = "deleted"
    SYNC_PENDING = "sync_pending"
    SYNCED = "synced"
    SYNC_FAILED = "sync_failed"


class SectionType(str, Enum):
    MANODOPERA = "manodopera"
    MATERIALI = "materiali"
    SMALTIMENTO = "smaltimento"


class PartType(str, Enum):
    RICAMBIO = "ricambio"
    CONSUMABILE = "consumabile"
    ACCESSORIO = "accessorio"


class PracticeType(str, Enum):
    PREVENTIVO = "preventivo"
    ORDINE_DI_LAVORO = "ordine_di_lavoro"


class CustomerType(str, Enum):
    PRIVATO = "privato"
    AZIENDA = "azienda"


class Context(str, Enum):
    OFFICINA = "officina"
    CARROZZERIA = "carrozzeria"
    REVISIONE = "revisione"


# Alias for backward compatibility
PracticeContext = Context


class OCRResult(BaseModel):
    plate: str
    confidence: float


def normalize_plate_value(value: str) -> str:
    cleaned = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    if len(cleaned) < 5 or len(cleaned) > 10:
        raise ValueError("Plate must be between 5 and 10 alphanumeric characters")
    return cleaned


def normalize_phone_value(value: str) -> str:
    raw = str(value or "").strip()
    cleaned = re.sub(r"[^0-9+]", "", raw)
    if cleaned.count("+") > 1 or ("+" in cleaned and not cleaned.startswith("+")):
        raise ValueError("Phone number format is invalid")
    digits_only = re.sub(r"[^0-9]", "", cleaned)
    if len(digits_only) < 6:
        raise ValueError("Phone number must have at least 6 digits")
    if cleaned.startswith("+"):
        return f"+{digits_only}"
    return digits_only


def normalize_customer_name(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError("Customer name cannot be empty")
    return normalized


class PracticePhotoCreate(BaseModel):
    telegram_file_id: str
    storage_path: str
    cloudinary_public_id: Optional[str] = None
    ocr_result: Optional[str] = None
    ocr_confidence: Optional[float] = None


class PracticePhoto(BaseModel):
    id: int
    practice_id: int
    telegram_file_id: str
    storage_path: str
    cloudinary_public_id: Optional[str] = None
    ocr_result: Optional[str] = None
    ocr_confidence: Optional[float] = None
    created_at: datetime

    class Config:
        from_attributes = True


class PracticeSectionCreate(BaseModel):
    context: Context
    description_rows: List[str]
    man_hours: Optional[float] = None
    mac_hours: Optional[float] = None
    materials_amount: Optional[float] = None
    waste_apply: Optional[bool] = None
    waste_percentage: Optional[float] = None
    notes: Optional[str] = None


class PracticeSection(BaseModel):
    id: int
    practice_id: int
    context: Context
    description_rows: List[str]
    man_hours: Optional[float] = None
    mac_hours: Optional[float] = None
    materials_amount: Optional[float] = None
    waste_apply: Optional[bool] = None
    waste_percentage: Optional[float] = None
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class PracticePartCreate(BaseModel):
    context: Context
    name: str
    quantity: Optional[str] = None


class PracticePart(BaseModel):
    id: int
    practice_id: int
    context: Context
    name: str
    quantity: Optional[str] = None

    class Config:
        from_attributes = True


class PracticeCreate(BaseModel):
    plate_confirmed: str = Field(..., min_length=5, max_length=10)
    phone: str = Field(..., min_length=6, max_length=20)
    customer_name: str = Field(..., min_length=1, max_length=200)
    customer_type: CustomerType
    billing_to_complete: bool = False
    appointment_date: datetime
    appointment_time: str  # HH:MM
    practice_type: PracticeType
    contexts: List[Context]
    internal_notes: Optional[str] = None

    @field_validator("plate_confirmed")
    @classmethod
    def validate_plate(cls, v: str) -> str:
        return normalize_plate_value(v)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return normalize_phone_value(v)

    @field_validator("customer_name")
    @classmethod
    def validate_customer_name(cls, v: str) -> str:
        return normalize_customer_name(v)


class PracticeUpdate(BaseModel):
    plate_confirmed: Optional[str] = None
    phone: Optional[str] = None
    customer_name: Optional[str] = None
    customer_type: Optional[CustomerType] = None
    billing_to_complete: Optional[bool] = None
    appointment_date: Optional[datetime] = None
    appointment_time: Optional[str] = None
    practice_type: Optional[PracticeType] = None
    contexts: Optional[List[Context]] = None
    internal_notes: Optional[str] = None

    @field_validator("plate_confirmed")
    @classmethod
    def validate_optional_plate(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return normalize_plate_value(v)

    @field_validator("phone")
    @classmethod
    def validate_optional_phone(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return normalize_phone_value(v)

    @field_validator("customer_name")
    @classmethod
    def validate_optional_customer_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return normalize_customer_name(v)


class Practice(BaseModel):
    id: int
    created_at: datetime
    updated_at: datetime
    created_by_telegram_id: int
    updated_by_telegram_id: Optional[int] = None
    status: PracticeStatus
    plate_detected: Optional[str] = None
    plate_confirmed: Optional[str] = None
    phone: Optional[str] = None
    customer_name: Optional[str] = None
    customer_type: CustomerType
    billing_to_complete: bool
    appointment_date: datetime
    appointment_time: str
    practice_type: PracticeType
    contexts: List[Context]
    internal_notes: Optional[str] = None
    management_external_id: Optional[str] = None
    management_sync_status: Optional[str] = None
    management_last_sync_at: Optional[datetime] = None
    management_audit_result: Optional[Dict[str, Any]] = None
    photos: List[PracticePhoto] = []
    sections: List[PracticeSection] = []
    parts: List[PracticePart] = []

    class Config:
        from_attributes = True


class PracticeDraft(BaseModel):
    """Modello per la bozza pratica creata dopo OCR targa"""
    id: int
    plate_detected: Optional[str] = None
    plate_confirmed: Optional[str] = None
    photo_id: int
    telegram_file_id: str


class TelegramMiniAppData(BaseModel):
    """Dati passati alla Mini App Telegram"""
    practice_id: Optional[int] = None
    plate_confirmed: Optional[str] = None
    photo_id: Optional[int] = None
    telegram_user_id: int


class PracticeSummary(BaseModel):
    """Riepilogo per il messaggio Telegram"""
    practice_id: int
    plate: str
    phone: str
    appointment: str
    practice_type: str
    contexts: List[str]
    sections_summary: Dict[str, Any]
    billing_warning: Optional[str] = None
    internal_notes: Optional[str] = None


class ValidationError(BaseModel):
    field: str
    message: str


class APIResponse(BaseModel):
    success: bool
    data: Optional[Any] = None
    errors: Optional[List[ValidationError]] = None
