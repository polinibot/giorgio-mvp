/**
 * Mappa completa Giorgio → destinazione YAP (tutte le sezioni).
 * Ogni riga: DOVE in YAP + CHI scrive oggi (mapping ≠ scrittura già attiva).
 */

import {
  pickCosa,
  pickYapTags,
  pickWorkBrief,
  yapSlotDuration,
  sortLavorazioniByReparto,
  collectDescriptionLines,
} from "./yap-mapping.mjs";
import {
  AGENDA_POPUP_FIELDS,
  AUTOMATISMI,
  WRITERS,
  YAP_NAV,
  writerLabel,
} from "./yap-targets.mjs";

function row(giorgioPath, yapId, yapPath, value, writer, note = null, worker = null) {
  return {
    giorgio: giorgioPath,
    yap: yapId,
    yapPath,
    value: value ?? null,
    writer,
    writerLabel: writerLabel(writer),
    worker: worker ?? (writer === WRITERS.GIORGIO_WORKER ? "implemented" : writer === WRITERS.GIORGIO_PLANNED ? "planned" : "n/a"),
    note,
  };
}

function mapAnagrafica(mapping) {
  const a = mapping.anagrafica || {};
  const base = `${YAP_NAV.praticaOverview}`;
  return [
    row("practice.plate_confirmed", "popup.cosa", `${YAP_NAV.agendaPopup} › ${AGENDA_POPUP_FIELDS.cosa.label}`, a.targa, WRITERS.GIORGIO_WORKER, "anche pratica.targa"),
    row("practice.plate_confirmed", "pratica.targa", `${base} › veicolo.targa`, a.targa, WRITERS.YAP_AUTO, "da prenotazione"),
    row("practice.customer_name", "pratica.cliente", `${base} › cliente`, a.cliente_nome, WRITERS.YAP_AUTO),
    row("practice.customer_name", "barra.cliente", `${YAP_NAV.agendaBar} › cliente`, a.cliente_nome, WRITERS.YAP_AUTO),
    row("practice.phone", "pratica.telefono", `${base} › telefono`, a.cliente_telefono, WRITERS.YAP_AUTO),
    row("practice.phone", "barra.telefono", `${YAP_NAV.agendaBar} › telefono`, a.cliente_telefono, WRITERS.YAP_AUTO),
    row("practice.customer_type", "pratica.tipo_cliente", `${base} › tipo cliente`, a.cliente_tipo, WRITERS.OPERATORE),
    row("practice.company_name", "pratica.ragione_sociale", `${base} › anagrafica fatturazione`, a.company_name, WRITERS.OPERATORE),
    row("practice.vat_number", "pratica.partita_iva", `${base} › P.IVA`, a.vat_number, WRITERS.OPERATORE),
    row("practice.fiscal_code", "pratica.codice_fiscale", `${base} › CF`, a.fiscal_code, WRITERS.OPERATORE),
    row("practice.billing_address", "pratica.indirizzo", `${base} › indirizzo`, a.billing_address, WRITERS.OPERATORE),
    row("practice.billing_city", "pratica.citta", `${base} › città`, a.billing_city, WRITERS.OPERATORE),
    row("practice.billing_zip", "pratica.cap", `${base} › CAP`, a.billing_zip, WRITERS.OPERATORE),
    row("(YAP veicolo)", "barra.modello", `${YAP_NAV.agendaBar} › modello veicolo`, null, WRITERS.YAP_AUTO, "anagrafica veicolo YAP"),
  ];
}

function mapAgenda(mapping) {
  const ag = mapping.agenda || {};
  const ora = ag.ora || ag.time || "";
  const durata = yapSlotDuration(mapping);
  const descLines = collectDescriptionLines(mapping);
  const pop = YAP_NAV.agendaPopup;

  return [
    row("practice.appointment_date", "popup.quando", `${pop} › ${AGENDA_POPUP_FIELDS.quando.label}`, ag.data, WRITERS.GIORGIO_WORKER),
    row("practice.appointment_time", "popup.dalle", `${pop} › ${AGENDA_POPUP_FIELDS.dalle.label}`, ora, WRITERS.GIORGIO_WORKER),
    row("(slot 20 min)", "popup.alle", `${pop} › ${AGENDA_POPUP_FIELDS.alle.label}`, durata, WRITERS.GIORGIO_WORKER, "fine = dalle + durata"),
    row("practice.practice_type", "popup.tag.preventivo", `${pop} › ${AGENDA_POPUP_FIELDS.tag.label}`, ag.tipo_pratica === "preventivo" ? "preventivo" : null, WRITERS.GIORGIO_WORKER, "se practice_type=preventivo"),
    row("practice.contexts[]", "popup.tag", `${pop} › ${AGENDA_POPUP_FIELDS.tag.label}`, pickYapTags(mapping).join(", "), WRITERS.GIORGIO_WORKER, "officina/revisione; carrozzeria→pneumatici"),
    row("(derivato)", "popup.cosa", `${pop} › ${AGENDA_POPUP_FIELDS.cosa.label}`, pickCosa(mapping), WRITERS.GIORGIO_WORKER, "revisione pura → REVISIONE"),
    row("meta.cosa_breve", "popup.cosa", `${pop} › ${AGENDA_POPUP_FIELDS.cosa.label}`, pickWorkBrief(mapping) || null, WRITERS.GIORGIO_PLANNED, "override titolo breve"),
    row("practice.internal_notes", "popup.note1", `${pop} › ${AGENDA_POPUP_FIELDS.note1.label}`, mapping.note_interne || null, WRITERS.GIORGIO_PLANNED, AGENDA_POPUP_FIELDS.note1.env || ""),
    row("sections.description_rows[]", "popup.note2", `${pop} › ${AGENDA_POPUP_FIELDS.note2.label}`, descLines.length ? descLines.join(" | ") : null, WRITERS.GIORGIO_PLANNED, "righe lavoro aggregate"),
  ];
}

function mapAgendaBar(mapping) {
  const a = mapping.anagrafica || {};
  const ag = mapping.agenda || {};
  const bar = YAP_NAV.agendaBar;
  return [
    row("practice.appointment_time", "barra.orario", `${bar} › fascia oraria`, ag.ora, WRITERS.YAP_AUTO),
    row("practice.plate_confirmed", "barra.targa", `${bar} › targa`, a.targa, WRITERS.YAP_AUTO),
    row("(YAP)", "barra.modello", `${bar} › modello`, null, WRITERS.YAP_AUTO),
    row("practice.customer_name", "barra.cliente", `${bar} › cliente`, a.cliente_nome, WRITERS.YAP_AUTO),
    row("practice.phone", "barra.telefono", `${bar} › telefono`, a.cliente_telefono, WRITERS.YAP_AUTO),
  ];
}

function mapGestionePratica(mapping) {
  return [
    row("(dopo save agenda)", "pratica.collegamento", `${YAP_NAV.praticaFromPopup}`, true, WRITERS.YAP_AUTO, "link nativo post-save"),
    row("anagrafica.*", "pratica.overview", YAP_NAV.praticaOverview, "—", WRITERS.YAP_AUTO, AUTOMATISMI.odlDaPrenotazione),
    row("practice.internal_notes", "pratica.note", `${YAP_NAV.praticaOverview} › note pratica`, mapping.note_interne, WRITERS.OPERATORE),
    row("practice.contexts[]", "pratica.sezioni_attive", `${YAP_NAV.praticaOverview} › menu laterale`, (mapping.contexts || []).join(", "), WRITERS.YAP_AUTO, "menu: Revisione, ODL, Materiali, …"),
  ];
}

let mappingRef = null;

function mapLavorazione(lav) {
  const rep = lav.reparto;
  const prefix = `sections.${rep}`;
  const odl = YAP_NAV.praticaOdl;
  const man = YAP_NAV.odlManodopera;
  const mat = YAP_NAV.odlMateriali;
  const art = YAP_NAV.odlArticoli;
  const smalt = YAP_NAV.praticaSmaltimento;
  const rev = YAP_NAV.praticaRevisione;
  const smaltVal = lav.smaltimento?.applica ? `${lav.smaltimento.percentuale ?? 2}%` : null;

  const fields = [
    row(
      `${prefix}.description_rows[]`,
      "odl.righe_descrizione",
      `${odl} › righe lavoro / descrizione`,
      (lav.descrizioni || []).join(" | ") || null,
      WRITERS.GIORGIO_PLANNED,
      AUTOMATISMI.odlDaPrenotazione,
    ),
    row(`${prefix}.notes`, "pratica.note_reparto", `${YAP_NAV.praticaOverview} › note reparto ${rep}`, lav.note, WRITERS.GIORGIO_PLANNED),
    row(`${prefix}.man_hours`, "odl.MANODOPERA.ore_uomo", `${man} › ore uomo (MAN)`, lav.ore_man, WRITERS.GIORGIO_PLANNED),
    row(`${prefix}.mac_hours`, "odl.MANODOPERA.ore_macchina", `${man} › ore macchina (MAC)`, lav.ore_mac, WRITERS.GIORGIO_PLANNED),
    row(`${prefix}.materials_amount`, "odl.MATERIALI_DI_CONSUMO", `${mat} (€)`, lav.materiali_euro, WRITERS.GIORGIO_PLANNED),
    row(`${prefix}.waste_apply`, "pratica.smaltimento", smalt, smaltVal, WRITERS.GIORGIO_PLANNED),
    row(
      `${prefix}.waste_percentage`,
      "pratica.smaltimento.%",
      `${smalt} › percentuale`,
      lav.smaltimento?.applica ? lav.smaltimento.percentuale : null,
      WRITERS.GIORGIO_PLANNED,
    ),
    row(`${prefix}.parts[]`, "odl.articoli", art, formatRicambi(lav.ricambi), WRITERS.GIORGIO_PLANNED, AUTOMATISMI.articoliDaTag),
  ];

  if (rep === "revisione") {
    fields.push(
      row(
        `${prefix}.description_rows[]`,
        "revisione.righe_ministeriali",
        `${rev} › righe controllo`,
        (lav.descrizioni || []).join(" | ") || null,
        WRITERS.YAP_AUTO,
        AUTOMATISMI.revisioneInPrenotazione,
      ),
    );
  }
  if (rep === "carrozzeria" && mappingRef?.agenda?.tipo_pratica === "preventivo") {
    fields.push(
      row("practice.practice_type", "pratica.preventivi", YAP_NAV.praticaPreventivi, "preventivo", WRITERS.OPERATORE, "comunicato solo dopo invio preventivo"),
    );
  }

  return { reparto: rep, sezioneYap: odl, fields };
}

function formatRicambi(ricambi) {
  const list = ricambi || [];
  if (!list.length) return null;
  return list.map((r) => `${r.name || r.nome}${r.quantity ? ` ×${r.quantity}` : ""}`).join("; ");
}

function mapAltro(mapping) {
  const meta = mapping.meta || {};
  return [
    row("practice.internal_notes", "pratica.note_interne", `${YAP_NAV.praticaOverview} › note`, mapping.note_interne, WRITERS.OPERATORE),
    row("meta.practice_id", "giorgio.id", "Giorgio DB", meta.practice_id, WRITERS.OPERATORE, "non in YAP"),
    row("meta.external_id", "yap.id_pratica", YAP_NAV.praticaOverview, meta.external_id, WRITERS.YAP_AUTO),
    row("photos[]", "pratica.allegati", `${YAP_NAV.praticaOverview} › allegati`, meta.photos_count != null ? `${meta.photos_count} foto` : null, WRITERS.OPERATORE),
  ];
}

/** Mappa tutti i campi: destinazione YAP completa per agenda, pratica, ODL. */
export function buildFullFieldMapping(mapping) {
  mappingRef = mapping;
  const contexts = new Set(mapping.contexts || []);
  const lavorazioni = sortLavorazioniByReparto(mapping.lavorazioni || []).filter(
    (l) => !contexts.size || contexts.has(l.reparto),
  );

  return {
    schemaVersion: "2.2-targets",
    mappingNote:
      "Ogni riga indica DOVE in YAP va il dato. «Giorgio worker» = già nel worker agenda; «pianificato» = destinazione definita, automazione ODL da implementare.",
    summary: {
      contesti: mapping.contexts || [],
      reparti: lavorazioni.map((l) => l.reparto),
      agendaWorker: ["popup.cosa", "popup.quando", "popup.dalle", "popup.alle", "popup.tag"],
      praticaYap: ["collegamento", "overview", AUTOMATISMI.odlDaPrenotazione],
      odlWorkerPlanned: ["MAN", "MAC", "materiali", "ricambi", "smaltimento", "note reparto"],
    },
    anagrafica: mapAnagrafica(mapping),
    agenda: mapAgenda(mapping),
    agendaBar: mapAgendaBar(mapping),
    gestionePratica: mapGestionePratica(mapping),
    ordiniDiLavoro: lavorazioni.map((l) => mapLavorazione(normalizeLav(l))),
    lavorazioni: lavorazioni.map((l) => mapLavorazione(normalizeLav(l))),
    altro: mapAltro(mapping),
    meta: {
      practiceId: mapping.meta?.practice_id || null,
      noteInterneMerged: mapping.note_interne || null,
    },
  };
}

function normalizeLav(l) {
  const wasteApply = l.smaltimento_applica ?? l.waste_apply ?? l.smaltimento?.applica ?? false;
  return {
    reparto: l.reparto,
    descrizioni: l.descrizioni || l.description_rows || [],
    ore_man: l.ore_man ?? l.man_hours ?? null,
    ore_mac: l.ore_mac ?? l.mac_hours ?? null,
    materiali_euro: l.materiali_euro ?? l.materials_amount ?? null,
    ricambi: l.ricambi || l.parts || [],
    note: l.note || l.notes || null,
    smaltimento: {
      applica: wasteApply,
      percentuale: l.smaltimento_percentuale ?? l.waste_percentage ?? l.smaltimento?.percentuale ?? null,
    },
  };
}
