"""Validazione orario appuntamento HH:MM (allineato a YAP / messaggi Telegram)."""

from __future__ import annotations

import re

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def validate_appointment_time(value: str) -> str:
    raw = (value or "").strip()
    if not _TIME_RE.match(raw):
        raise ValueError("Orario non valido: usa formato HH:MM (es. 09:24)")
    return raw
