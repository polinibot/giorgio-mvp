"""Mappa completa Giorgio → destinazione YAP (allineata a automation/yap/lib/yap-field-map.mjs)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from yap_mapping import pick_cosa, pick_yap_tags, pick_work_brief, yap_slot_duration, _sort_lavorazioni, _collect_description_lines
from yap_targets import AUTOMATISMI, WRITERS, YAP_NAV, writer_label


def _row(
    giorgio: str,
    yap_id: str,
    yap_path: str,
    value: Any,
    writer: str,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    worker = "implemented" if writer == WRITERS["GIORGIO_WORKER"] else "planned" if writer == WRITERS["GIORGIO_PLANNED"] else "n/a"
    return {
        "giorgio": giorgio,
        "yap": yap_id,
        "yapPath": yap_path,
        "value": value,
        "writer": writer,
        "writerLabel": writer_label(writer),
        "worker": worker,
        "note": note,
    }


def _format_ricambi(ricambi: List[Dict[str, Any]]) -> Optional[str]:
    if not ricambi:
        return None
    parts = []
    for r in ricambi:
        name = r.get("name") or r.get("nome") or ""
        qty = r.get("quantity")
        parts.append(f"{name} ×{qty}" if qty else name)
    return "; ".join(parts) if parts else None


def _normalize_lav(item: Dict[str, Any]) -> Dict[str, Any]:
    waste_apply = (
        item.get("smaltimento_applica")
        or item.get("waste_apply")
        or (item.get("smaltimento") or {}).get("applica")
        or False
    )
    return {
        "reparto": item.get("reparto"),
        "descrizioni": item.get("descrizioni") or item.get("description_rows") or [],
        "ore_man": item.get("ore_man") if item.get("ore_man") is not None else item.get("man_hours"),
        "ore_mac": item.get("ore_mac") if item.get("ore_mac") is not None else item.get("mac_hours"),
        "materiali_euro": item.get("materiali_euro")
        if item.get("materiali_euro") is not None
        else item.get("materials_amount"),
        "ricambi": item.get("ricambi") or item.get("parts") or [],
        "note": item.get("note") or item.get("notes"),
        "smaltimento": {
            "applica": waste_apply,
            "percentuale": item.get("smaltimento_percentuale")
            or item.get("waste_percentage")
            or (item.get("smaltimento") or {}).get("percentuale"),
        },
    }


def _map_anagrafica(mapping: Dict[str, Any]) -> List[Dict[str, Any]]:
    a = mapping.get("anagrafica") or {}
    base = YAP_NAV["pratica_overview"]
    pop = YAP_NAV["agenda_popup"]
    return [
        _row("practice.plate_confirmed", "popup.cosa", f"{pop} › Cosa", a.get("targa"), WRITERS["GIORGIO_WORKER"]),
        _row("practice.plate_confirmed", "pratica.targa", f"{base} › veicolo.targa", a.get("targa"), WRITERS["YAP_AUTO"]),
        _row("practice.customer_name", "pratica.cliente", f"{base} › cliente", a.get("cliente_nome"), WRITERS["YAP_AUTO"]),
        _row("practice.phone", "pratica.telefono", f"{base} › telefono", a.get("cliente_telefono"), WRITERS["YAP_AUTO"]),
        _row("practice.customer_type", "pratica.tipo_cliente", f"{base} › tipo cliente", a.get("cliente_tipo"), WRITERS["OPERATORE"]),
        _row("practice.company_name", "pratica.ragione_sociale", f"{base} › ragione sociale", a.get("company_name"), WRITERS["OPERATORE"]),
        _row("practice.vat_number", "pratica.partita_iva", f"{base} › P.IVA", a.get("vat_number"), WRITERS["OPERATORE"]),
        _row("practice.fiscal_code", "pratica.codice_fiscale", f"{base} › CF", a.get("fiscal_code"), WRITERS["OPERATORE"]),
        _row("practice.billing_address", "pratica.indirizzo", f"{base} › indirizzo", a.get("billing_address"), WRITERS["OPERATORE"]),
        _row("practice.billing_city", "pratica.citta", f"{base} › città", a.get("billing_city"), WRITERS["OPERATORE"]),
        _row("practice.billing_zip", "pratica.cap", f"{base} › CAP", a.get("billing_zip"), WRITERS["OPERATORE"]),
        _row("(YAP veicolo)", "barra.modello", f"{YAP_NAV['agenda_bar']} › modello", None, WRITERS["YAP_AUTO"]),
    ]


def _map_agenda(mapping: Dict[str, Any]) -> List[Dict[str, Any]]:
    ag = mapping.get("agenda") or {}
    ora = ag.get("ora") or ag.get("time") or ""
    durata = yap_slot_duration(mapping)
    desc = _collect_description_lines(mapping)
    pop = YAP_NAV["agenda_popup"]
    return [
        _row("practice.appointment_date", "popup.quando", f"{pop} › Quando", ag.get("data"), WRITERS["GIORGIO_WORKER"]),
        _row("practice.appointment_time", "popup.dalle", f"{pop} › dalle", ora, WRITERS["GIORGIO_WORKER"]),
        _row("(slot 20 min)", "popup.alle", f"{pop} › alle", durata, WRITERS["GIORGIO_WORKER"]),
        _row("practice.contexts[]", "popup.tag", f"{pop} › Tag", ", ".join(pick_yap_tags(mapping)), WRITERS["GIORGIO_WORKER"]),
        _row("(derivato)", "popup.cosa", f"{pop} › Cosa", pick_cosa(mapping), WRITERS["GIORGIO_WORKER"]),
        _row("meta.cosa_breve", "popup.cosa", f"{pop} › Cosa", pick_work_brief(mapping) or None, WRITERS["GIORGIO_PLANNED"]),
        _row("practice.internal_notes", "popup.note1", f"{pop} › note 1", mapping.get("note_interne"), WRITERS["GIORGIO_PLANNED"]),
        _row("sections.description_rows[]", "popup.note2", f"{pop} › note 2", " | ".join(desc) if desc else None, WRITERS["GIORGIO_PLANNED"]),
    ]


def _map_agenda_bar(mapping: Dict[str, Any]) -> List[Dict[str, Any]]:
    a = mapping.get("anagrafica") or {}
    ag = mapping.get("agenda") or {}
    bar = YAP_NAV["agenda_bar"]
    return [
        _row("practice.appointment_time", "barra.orario", f"{bar} › fascia", ag.get("ora"), WRITERS["YAP_AUTO"]),
        _row("practice.plate_confirmed", "barra.targa", f"{bar} › targa", a.get("targa"), WRITERS["YAP_AUTO"]),
        _row("practice.customer_name", "barra.cliente", f"{bar} › cliente", a.get("cliente_nome"), WRITERS["YAP_AUTO"]),
        _row("practice.phone", "barra.telefono", f"{bar} › telefono", a.get("cliente_telefono"), WRITERS["YAP_AUTO"]),
    ]


def _map_gestione_pratica(mapping: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        _row("(dopo save)", "pratica.collegamento", YAP_NAV["pratica_from_popup"], True, WRITERS["YAP_AUTO"]),
        _row("anagrafica.*", "pratica.overview", YAP_NAV["pratica_overview"], "—", WRITERS["YAP_AUTO"], AUTOMATISMI["odl"]),
        _row("practice.internal_notes", "pratica.note", f"{YAP_NAV['pratica_overview']} › note", mapping.get("note_interne"), WRITERS["OPERATORE"]),
    ]


def _map_lavorazione(item: Dict[str, Any], mapping: Dict[str, Any]) -> Dict[str, Any]:
    lav = _normalize_lav(item)
    rep = lav["reparto"]
    prefix = f"sections.{rep}"
    odl = YAP_NAV["pratica_odl"]
    man = YAP_NAV["odl_manodopera"]
    mat = YAP_NAV["odl_materiali"]
    art = YAP_NAV["odl_articoli"]
    smalt = YAP_NAV["pratica_smaltimento"]
    desc = " | ".join(lav["descrizioni"]) if lav["descrizioni"] else None
    smalt_val = f"{lav['smaltimento']['percentuale'] or 2}%" if lav["smaltimento"]["applica"] else None

    fields = [
        _row(f"{prefix}.description_rows[]", "odl.righe", f"{odl} › righe lavoro", desc, WRITERS["GIORGIO_PLANNED"], AUTOMATISMI["odl"]),
        _row(f"{prefix}.notes", "pratica.note_reparto", f"{YAP_NAV['pratica_overview']} › note {rep}", lav["note"], WRITERS["GIORGIO_PLANNED"]),
        _row(f"{prefix}.man_hours", "odl.MANODOPERA.ore_uomo", f"{man} › MAN", lav["ore_man"], WRITERS["GIORGIO_PLANNED"]),
        _row(f"{prefix}.mac_hours", "odl.MANODOPERA.ore_macchina", f"{man} › MAC", lav["ore_mac"], WRITERS["GIORGIO_PLANNED"]),
        _row(f"{prefix}.materials_amount", "odl.MATERIALI", f"{mat} (€)", lav["materiali_euro"], WRITERS["GIORGIO_PLANNED"]),
        _row(f"{prefix}.waste_apply", "pratica.smaltimento", smalt, smalt_val, WRITERS["GIORGIO_PLANNED"]),
        _row(f"{prefix}.parts[]", "odl.articoli", art, _format_ricambi(lav["ricambi"]), WRITERS["GIORGIO_PLANNED"], AUTOMATISMI["articoli"]),
    ]
    if rep == "revisione":
        fields.append(
            _row(
                f"{prefix}.description_rows[]",
                "revisione.righe",
                f"{YAP_NAV['pratica_revisione']} › righe controllo",
                desc,
                WRITERS["YAP_AUTO"],
                AUTOMATISMI["revisione"],
            )
        )
    return {"reparto": rep, "sezioneYap": odl, "fields": fields}


def build_full_field_mapping(mapping: Dict[str, Any]) -> Dict[str, Any]:
    contexts = set(mapping.get("contexts") or [])
    lavorazioni = [
        item
        for item in _sort_lavorazioni(mapping.get("lavorazioni") or [])
        if not contexts or item.get("reparto") in contexts
    ]
    lav_maps = [_map_lavorazione(item, mapping) for item in lavorazioni]
    return {
        "schemaVersion": "2.2-targets",
        "mappingNote": "Ogni riga = DOVE in YAP. Chi scrive oggi ≠ mapping incompleto.",
        "summary": {
            "contesti": list(mapping.get("contexts") or []),
            "reparti": [l.get("reparto") for l in lavorazioni],
            "agendaWorker": ["popup.cosa", "popup.quando", "popup.dalle", "popup.alle", "popup.tag"],
            "odlWorkerPlanned": ["MAN", "MAC", "materiali", "ricambi", "smaltimento"],
        },
        "anagrafica": _map_anagrafica(mapping),
        "agenda": _map_agenda(mapping),
        "agendaBar": _map_agenda_bar(mapping),
        "gestionePratica": _map_gestione_pratica(mapping),
        "ordiniDiLavoro": lav_maps,
        "lavorazioni": lav_maps,
        "altro": [
            _row("practice.internal_notes", "pratica.note", YAP_NAV["pratica_overview"], mapping.get("note_interne"), WRITERS["OPERATORE"]),
        ],
    }
