/**
 * Canonical YAP destinations (where each Giorgio datum belongs).
 * writer: what inserts today | worker: Giorgio worker implementation
 */

export const WRITERS = {
  GIORGIO_WORKER: "giorgio_worker",
  GIORGIO_PLANNED: "giorgio_worker_planned",
  YAP_AUTO: "yap_automatismo",
  OPERATORE: "operatore_yap",
};

export const YAP_NAV = {
  agendaPopup: "Agenda > double click appointment > popup 'Dettagli appuntamento'",
  agendaBar: "Agenda > event bar (title composed by YAP)",
  praticaFromPopup: "Appointment popup > link 'Gestione pratica'",
  praticaOverview: "Gestione pratica > overview (PraticaGetOverviewAction)",
  praticaRevisione: "Gestione pratica > menu 'Revisione'",
  praticaPreventivi: "Gestione pratica > menu 'Preventivi'",
  praticaOdl: "Gestione pratica > menu 'Ordini di lavoro'",
  praticaMateriali: "Gestione pratica > menu 'Materiali di consumo'",
  praticaSmaltimento: "Gestione pratica > menu 'Smaltimento rifiuti'",
  praticaDocumenti: "Gestione pratica > menu 'Documenti fiscali'",
  odlManodopera: "Ordini di lavoro > MANODOPERA rows (PropertyGetAction catalog)",
  odlMateriali: "Ordini di lavoro > MATERIALI DI CONSUMO",
  odlArticoli: "Ordini di lavoro > warehouse items / document rows",
  odlDeleteToolbar: "Ordini di lavoro > toolbar 'Elimina'",
  odlDeleteConfirm: "Ordini di lavoro > confirm 'Confermi di voler eliminare l'ordine di lavoro?'",
};

/** Agenda popup fields (observed UI order). */
export const AGENDA_POPUP_FIELDS = {
  cosa: { id: "cosa", label: "Cosa", index: 1, writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  quando: { id: "quando", label: "Quando", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  dalle: { id: "dalle", label: "dalle", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  alle: { id: "alle", label: "alle", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  note1: { id: "note1", label: "note (field 1)", writer: WRITERS.GIORGIO_PLANNED, worker: "planned", env: "YAP_FILL_NOTES=1" },
  note2: { id: "note2", label: "note (field 2)", writer: WRITERS.GIORGIO_PLANNED, worker: "planned" },
  tag: { id: "tag", label: "Tag (chip)", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
};

export const AUTOMATISMI = {
  odlDaPrenotazione: "AutomatismoOdlDaPrenotazione",
  revisioneInPrenotazione: "AutomatismoRevisioneInPrenotazione",
  articoliDaTag: "AutomatismoArticoloDocumentoFromTagPrenotazione",
};

export function writerLabel(writer) {
  const map = {
    [WRITERS.GIORGIO_WORKER]: "Giorgio worker",
    [WRITERS.GIORGIO_PLANNED]: "Giorgio worker (planned)",
    [WRITERS.YAP_AUTO]: "YAP automation",
    [WRITERS.OPERATORE]: "YAP operator",
  };
  return map[writer] || writer;
}
