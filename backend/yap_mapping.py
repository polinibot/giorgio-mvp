"""Rules Giorgio -> YAP agenda, aligned with automation/yap/lib/yap-mapping.mjs."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

GENERIC_REVISIONE = re.compile(r"^(revisione(\s+periodica)?|rev\.?)$", re.I)
REPARTO_ORDER = ["officina", "carrozzeria", "revisione"]


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _contexts_from_mapping(mapping: Dict[str, Any]) -> List[str]:
    contexts = mapping.get("contexts") or []
    if isinstance(contexts, str):
        contexts = [c.strip() for c in contexts.split(",") if c.strip()]
    if contexts:
        return list(contexts)
    return [item.get("reparto") for item in (mapping.get("lavorazioni") or []) if item.get("reparto")]


def reparto_sort_index(reparto: Optional[str]) -> int:
    if reparto in REPARTO_ORDER:
        return REPARTO_ORDER.index(reparto)
    return 99


def _sort_lavorazioni(lavorazioni: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(lavorazioni or [], key=lambda item: reparto_sort_index(item.get("reparto")))


def is_revisione_pura(contexts: List[str], lavorazioni: Optional[List[Dict[str, Any]]] = None) -> bool:
    del lavorazioni
    return len(contexts) == 1 and contexts[0] == "revisione"


def _collect_description_lines(mapping: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    contexts = set(_contexts_from_mapping(mapping))
    for lav in _sort_lavorazioni(mapping.get("lavorazioni") or []):
        reparto = lav.get("reparto")
        if contexts and reparto not in contexts:
            continue
        for desc in lav.get("descrizioni") or []:
            text = str(desc or "").strip()
            if text:
                lines.append(text)
    return lines


def pick_work_brief(mapping: Dict[str, Any]) -> str:
    meta = mapping.get("meta") or {}
    override = meta.get("cosa_breve") or meta.get("work_brief")
    if override:
        return str(override).strip().upper()[:28]
    for line in _collect_description_lines(mapping):
        if not GENERIC_REVISIONE.match(line):
            return line.upper()[:28]
    return ""


def pick_cosa(mapping: Dict[str, Any]) -> str:
    anag = mapping.get("anagrafica") or {}
    meta = mapping.get("meta") or {}
    override = meta.get("cosa_override") or anag.get("riferimento_breve")
    if override:
        return str(override).strip().upper()[:40]

    contexts = _contexts_from_mapping(mapping)
    if is_revisione_pura(contexts, mapping.get("lavorazioni") or []):
        return "REVISIONE"

    plate = str(anag.get("targa") or "").strip().upper()
    brief = pick_work_brief(mapping)
    if plate and brief:
        return f"{plate} - {brief}"[:40]
    return plate[:40]


def pick_yap_tags(mapping: Dict[str, Any]) -> List[str]:
    contexts = _contexts_from_mapping(mapping)
    agenda = mapping.get("agenda") or {}
    tipo = agenda.get("tipo_pratica") or ""
    tags: List[str] = []

    if "officina" in contexts:
        tags.append("officina")
    if "revisione" in contexts:
        tags.append("revisione")
    if "carrozzeria" in contexts:
        tags.append("pneumatici")
        if tipo == "preventivo":
            tags.append("preventivo")
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


def yap_slot_duration(mapping: Dict[str, Any]) -> int:
    agenda = mapping.get("agenda") or {}
    return _safe_int(agenda.get("durata_minuti") or agenda.get("slot_duration"), 20)


def build_yap_preview(mapping: Dict[str, Any], pre_sync: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    agenda = mapping.get("agenda") or {}
    anag = mapping.get("anagrafica") or {}
    contexts = _contexts_from_mapping(mapping)
    durata = yap_slot_duration(mapping)
    ora = agenda.get("ora") or agenda.get("time") or ""
    tags = pick_yap_tags(mapping)
    cosa = pick_cosa(mapping)
    cosa_breve = pick_work_brief(mapping) or None

    pure_revisione = is_revisione_pura(contexts, mapping.get("lavorazioni") or [])
    return {
        "mode": "preview_only_no_yap_write",
        "giorgioSummary": {
            "cliente": anag.get("cliente_nome"),
            "telefono": anag.get("cliente_telefono"),
            "targa": anag.get("targa"),
            "data": agenda.get("data"),
            "ora": ora,
            "durata_minuti": durata,
            "contesti": contexts,
            "tipo_pratica": agenda.get("tipo_pratica"),
            "cosa_breve": cosa_breve,
            "note_interne": mapping.get("note_interne"),
        },
        "proposedYap": {
            "popup": {
                "cosa": cosa,
                "quando": to_italian_date(agenda.get("data")),
                "dalle": to_yap_time(ora),
                "alle": add_minutes(ora, durata),
                "tag": tags,
                "note1_proposed": None,
            },
            "delegatedToYap": ["gestione_pratica", "odl_base"],
            "odl": {
                "action": "mapping_complete_worker_planned",
                "yapMenu": ["Ordini di lavoro", "Materiali di consumo", "Smaltimento rifiuti", "Revisione"],
                "lavorazioniGiorgio": [
                    {
                        "reparto": lav.get("reparto"),
                        "descrizioni": lav.get("descrizioni") or [],
                        "ore_man": lav.get("ore_man"),
                        "ore_mac": lav.get("ore_mac"),
                        "materiali_euro": lav.get("materiali_euro"),
                        "ricambi": lav.get("ricambi") or [],
                        "smaltimento": {
                            "applica": lav.get("smaltimento_applica"),
                            "percentuale": lav.get("smaltimento_percentuale"),
                        },
                        "noteReparto": (lav.get("note") or lav.get("notes") or None),
                    }
                    for lav in _sort_lavorazioni(mapping.get("lavorazioni") or [])
                    if not contexts or lav.get("reparto") in contexts
                ],
            },
        },
        "preSync": pre_sync,
        "confidence": {
            "cosa": "high" if pure_revisione else "indicative",
            "cosaNote": None if pure_revisione else "YAP composes agenda title; popup Cosa is best-effort from mini-app data",
            "tag": "high" if tags else "low",
            "write_ready": bool(pre_sync and pre_sync.get("ready")),
        },
    }
