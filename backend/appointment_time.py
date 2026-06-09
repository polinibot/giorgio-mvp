"""Validazione e normalizzazione orario appuntamento HH:MM."""

from __future__ import annotations

import os
import re

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DEFAULT_SLOT_MINUTES = 20
_DEFAULT_VISIBLE_START = "08:00"
_DEFAULT_VISIBLE_END = "18:00"


def get_yap_slot_minutes() -> int:
    raw = os.getenv("YAP_SLOT_MINUTES", str(_DEFAULT_SLOT_MINUTES)).strip()
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_SLOT_MINUTES
    return value if value > 0 else _DEFAULT_SLOT_MINUTES


def _get_visible_time(env_name: str, default: str) -> str:
    raw = os.getenv(env_name, default).strip()
    return raw if _TIME_RE.match(raw) else default


def get_yap_visible_start_time() -> str:
    return _get_visible_time("YAP_VISIBLE_START_TIME", _DEFAULT_VISIBLE_START)


def get_yap_visible_end_time() -> str:
    return _get_visible_time("YAP_VISIBLE_END_TIME", _DEFAULT_VISIBLE_END)


def _time_to_minutes(value: str) -> int:
    return int(value[:2]) * 60 + int(value[3:5])


def validate_appointment_time(value: str, slot_minutes: int | None = None) -> str:
    raw = (value or "").strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Orario non valido: usa formato HH:MM (es. 09:24)")
    step = slot_minutes or get_yap_slot_minutes()
    if step <= 0:
        step = _DEFAULT_SLOT_MINUTES
    rounded_minutes = _round_minutes(_time_to_minutes(raw), step)
    start_minutes = _time_to_minutes(get_yap_visible_start_time())
    end_minutes = _time_to_minutes(get_yap_visible_end_time())
    if rounded_minutes < start_minutes or rounded_minutes > end_minutes:
        raise ValueError(
            f"Orario fuori fascia YAP: usa un orario tra {get_yap_visible_start_time()} e {get_yap_visible_end_time()}"
        )
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
    step = slot_minutes or get_yap_slot_minutes()
    if step <= 0:
        step = _DEFAULT_SLOT_MINUTES
    raw = validate_appointment_time(value, step)
    minutes = _time_to_minutes(raw)
    return _format_minutes(_round_minutes(minutes, step))
