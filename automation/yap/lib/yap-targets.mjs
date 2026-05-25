/**
 * Destinazioni YAP canoniche (dove va ogni dato Giorgio).
 * writer: chi inserisce oggi | worker: implementazione worker Giorgio
 */

export const WRITERS = {
  GIORGIO_WORKER: "giorgio_worker",
  GIORGIO_PLANNED: "giorgio_worker_planned",
  YAP_AUTO: "yap_automatismo",
  OPERATORE: "operatore_yap",
};

export const YAP_NAV = {
  agendaPopup: "Agenda › doppio click appuntamento › popup «Dettagli appuntamento»",
  agendaBar: "Agenda › barra evento (titolo composto da YAP)",
  praticaFromPopup: "Popup appuntamento › link «Gestione pratica»",
  praticaOverview: "Gestione pratica › overview (PraticaGetOverviewAction)",
  praticaRevisione: "Gestione pratica › menu «Revisione»",
  praticaPreventivi: "Gestione pratica › menu «Preventivi»",
  praticaOdl: "Gestione pratica › menu «Ordini di lavoro»",
  praticaMateriali: "Gestione pratica › menu «Materiali di consumo»",
  praticaSmaltimento: "Gestione pratica › menu «Smaltimento rifiuti»",
  praticaDocumenti: "Gestione pratica › menu «Documenti fiscali»",
  odlManodopera: "Ordini di lavoro › righe MANODOPERA (catalogo PropertyGetAction)",
  odlMateriali: "Ordini di lavoro › MATERIALI DI CONSUMO",
  odlArticoli: "Ordini di lavoro › articoli magazzino / righe documento",
};

/** Campi popup agenda (ordine UI osservato). */
export const AGENDA_POPUP_FIELDS = {
  cosa: { id: "cosa", label: "Cosa", index: 1, writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  quando: { id: "quando", label: "Quando", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  dalle: { id: "dalle", label: "dalle", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  alle: { id: "alle", label: "alle", writer: WRITERS.GIORGIO_WORKER, worker: "implemented" },
  note1: { id: "note1", label: "note (campo 1)", writer: WRITERS.GIORGIO_PLANNED, worker: "planned", env: "YAP_FILL_NOTES=1" },
  note2: { id: "note2", label: "note (campo 2)", writer: WRITERS.GIORGIO_PLANNED, worker: "planned" },
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
    [WRITERS.GIORGIO_PLANNED]: "Giorgio worker (pianificato)",
    [WRITERS.YAP_AUTO]: "Automatismo YAP",
    [WRITERS.OPERATORE]: "Operatore in YAP",
  };
  return map[writer] || writer;
}
