"""Regole Giorgio → YAP agenda (allineate a automation/yap/lib/yap-mapping.mjs)."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional


def _has_revisione_lavorazione(lavorazioni: List[Dict[str, Any]]) -> bool:
    for item in lavorazioni or []:
        if item.get("reparto") == "revisione":
            return True
        for desc in item.get("descrizioni") or []:
            if re.search(r"revisione", str(desc), re.I):
                return True
    return False


def is_revisione_pura(contexts: List[str], lavorazioni: List[Dict[str, Any]]) -> bool:
    reparti = list({l.get("reparto") for l in (lavorazioni or []) if l.get("reparto")})
    if len(contexts) == 1 and contexts[0] == "revisione":
        return True
    if len(reparti) == 1 and reparti[0] == "revisione":
        return True
    return False


def pick_cosa(mapping: Dict[str, Any]) -> str:
    anag = mapping.get("anagrafica") or {}
    meta = mapping.get("meta") or {}
    override = meta.get("cosa_override") or anag.get("riferimento_breve")
    if override:
        return str(override).strip().upper()[:40]
    contexts = mapping.get("contexts") or []
    lavorazioni = mapping.get("lavorazioni") or []
    if is_revisione_pura(contexts, lavorazioni):
        return "REVISIONE"
    return str(anag.get("targa") or "").strip().upper()[:40]


def pick_yap_tags(mapping: Dict[str, Any]) -> List[str]:
    contexts = mapping.get("contexts") or []
    lavorazioni = mapping.get("lavorazioni") or []
    agenda = mapping.get("agenda") or {}
    tipo = agenda.get("tipo_pratica") or ""
    tags: List[str] = []

    if len(contexts) > 1:
        return ["revisione"]

    if "officina" in contexts:
        tags.append("officina")
    if "revisione" in contexts:
        tags.append("revisione")

    if "carrozzeria" in contexts:
        if _has_revisione_lavorazione(lavorazioni):
            tags.append("revisione")
        else:
            tags.append("pneumatici")
            if tipo == "preventivo":
                tags.extend(["preventivo", "comunicato"])

    if not tags and "pneumatici" in contexts:
        tags.append("pneumatici")

    return list(dict.fromkeys(tags))


def to_italian_date(iso_date: Optional[str]) -> str:
    raw = str(iso_date or "")[:10]
    parts = raw.split("-")
    if len(parts) != 3:
        return raw
    y, m, d = parts
    return f"{d}/{m}/{y}"


def to_yap_time(time_str: Optional[str]) -> str:
    return str(time_str or "").strip().replace(":", ".")


def add_minutes(time_str: str, minutes: int) -> str:
    h, m = map(int, str(time_str or "00:00").split(":"))
    dt = datetime(2000, 1, 1, h, m) + timedelta(minutes=minutes)
    return f"{dt.hour:02d}.{dt.minute:02d}"


def build_yap_preview(mapping: Dict[str, Any], pre_sync: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    agenda = mapping.get("agenda") or {}
    anag = mapping.get("anagrafica") or {}
    durata = int(agenda.get("durata_minuti") or agenda.get("slot_duration") or 20)
    ora = agenda.get("ora") or agenda.get("time") or ""
    tags = pick_yap_tags(mapping)
    plate = pick_cosa(mapping)

    return {
        "mode": "preview_only_no_yap_write",
        "giorgioSummary": {
            "cliente": anag.get("cliente_nome"),
            "telefono": anag.get("cliente_telefono"),
            "targa": anag.get("targa"),
            "data": agenda.get("data"),
            "ora": ora,
            "durata_minuti": durata,
            "contesti": mapping.get("contexts") or [],
            "tipo_pratica": agenda.get("tipo_pratica"),
        },
        "proposedYap": {
            "popup": {
                "cosa": plate,
                "quando": to_italian_date(agenda.get("data")),
                "dalle": to_yap_time(ora),
                "alle": add_minutes(ora, durata),
                "tag": tags,
                "note1_proposed": None,
            },
            "delegatedToYap": ["gestione_pratica", "odl_base"],
        },
        "preSync": pre_sync,
        "confidence": {
            "cosa": "high",
            "tag": "high" if tags else "low",
            "write_ready": bool(pre_sync and pre_sync.get("ready")),
        },
    }
