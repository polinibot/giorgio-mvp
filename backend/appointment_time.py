"""Validazione e normalizzazione orario appuntamento HH:MM."""

from __future__ import annotations

import os
import re

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DEFAULT_SLOT_MINUTES = 20


def get_yap_slot_minutes() -> int:
    raw = os.getenv("YAP_SLOT_MINUTES", str(_DEFAULT_SLOT_MINUTES)).strip()
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_SLOT_MINUTES
    return value if value > 0 else _DEFAULT_SLOT_MINUTES


def validate_appointment_time(value: str) -> str:
    raw = (value or "").strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Orario non valido: usa formato HH:MM (es. 09:24)")
    return raw


def _round_minutes(total_minutes: int, slot_minutes: int) -> int:
    remainder = total_minutes % slot_minutes
    lower = total_minutes - remainder
    upper = lower + slot_minutes

    if remainder == 0:
        rounded = total_minutes
    elif remainder * 2 >= slot_minutes:
        rounded = upper
    else:
        rounded = lower

    max_valid = (24 * 60) - slot_minutes
    if rounded < 0:
        return 0
    if rounded > max_valid:
        return max_valid
    return rounded


def _format_minutes(total_minutes: int) -> str:
    hours, minutes = divmod(total_minutes, 60)
    return f"{hours:02d}:{minutes:02d}"


def normalize_appointment_time(value: str, slot_minutes: int | None = None) -> str:
    raw = validate_appointment_time(value)
    minutes = int(raw[:2]) * 60 + int(raw[3:5])
    step = slot_minutes or get_yap_slot_minutes()
    if step <= 0:
        step = _DEFAULT_SLOT_MINUTES
    return _format_minutes(_round_minutes(minutes, step))
