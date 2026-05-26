"""Destinazioni YAP canoniche (allineate a automation/yap/lib/yap-targets.mjs)."""

from __future__ import annotations

WRITERS = {
    "GIORGIO_WORKER": "giorgio_worker",
    "GIORGIO_PLANNED": "giorgio_worker_planned",
    "YAP_AUTO": "yap_automatismo",
    "OPERATORE": "operatore_yap",
}

YAP_NAV = {
    "agenda_popup": "Agenda › doppio click appuntamento › popup «Dettagli appuntamento»",
    "agenda_bar": "Agenda › barra evento (titolo composto da YAP)",
    "pratica_from_popup": "Popup appuntamento › link «Gestione pratica»",
    "pratica_overview": "Gestione pratica › overview (PraticaGetOverviewAction)",
    "pratica_revisione": "Gestione pratica › menu «Revisione»",
    "pratica_preventivi": "Gestione pratica › menu «Preventivi»",
    "pratica_odl": "Gestione pratica › menu «Ordini di lavoro»",
    "pratica_materiali": "Gestione pratica › menu «Materiali di consumo»",
    "pratica_smaltimento": "Gestione pratica › menu «Smaltimento rifiuti»",
    "odl_manodopera": "Ordini di lavoro › righe MANODOPERA",
    "odl_materiali": "Ordini di lavoro › MATERIALI DI CONSUMO",
    "odl_articoli": "Ordini di lavoro › articoli magazzino",
}

AUTOMATISMI = {
    "odl": "AutomatismoOdlDaPrenotazione",
    "revisione": "AutomatismoRevisioneInPrenotazione",
    "articoli": "AutomatismoArticoloDocumentoFromTagPrenotazione",
}

WRITER_LABELS = {
    WRITERS["GIORGIO_WORKER"]: "Giorgio worker",
    WRITERS["GIORGIO_PLANNED"]: "Giorgio worker (pianificato)",
    WRITERS["YAP_AUTO"]: "Automatismo YAP",
    WRITERS["OPERATORE"]: "Operatore in YAP",
}


def writer_label(writer: str) -> str:
    return WRITER_LABELS.get(writer, writer)
