/**
 * Regole Giorgio → YAP (v2).
 * Fonte di verità: contesti scelti in mini-app (practice.contexts).
 */

import { buildFullFieldMapping } from "./yap-field-map.mjs";
import { getYapSlotMinutes, normalizeAppointmentTime } from "./yap-shared.mjs";

const GENERIC_REVISIONE = /^(revisione(\s+periodica)?|rev\.?)$/i;
const WORK_CONTEXTS = new Set(["officina", "carrozzeria"]);

/** Priorità titolo breve agenda (Cosa) quando più reparti sono attivi. */
export const REPARTO_ORDER = ["officina", "carrozzeria", "revisione"];

/**
 * Alias reparto Giorgio -> sezione/etichetta usata in YAP.
 * Su YAP non esiste ancora una sezione "carrozzeria": si usa "pneumatici"
 * (stesso criterio dei tag). Serve al worker per navigare/compilare l'ODL.
 */
export const REPARTO_YAP_ALIAS = { carrozzeria: "pneumatici" };

export function yapRepartoForOdl(reparto) {
  const r = String(reparto || "").trim().toLowerCase();
  return REPARTO_YAP_ALIAS[r] || r;
}

export function repartoSortIndex(reparto) {
  const i = REPARTO_ORDER.indexOf(reparto);
  return i === -1 ? 99 : i;
}

export function sortLavorazioniByReparto(lavorazioni) {
  return [...(lavorazioni || [])].sort(
    (a, b) => repartoSortIndex(a.reparto) - repartoSortIndex(b.reparto),
  );
}

export function normalizeMappingInput(raw) {
  const m = raw?.mapping || raw?.data?.mapping || raw;
  let contexts = m.contexts || [];
  if (typeof contexts === "string") {
    contexts = contexts.split(",").map((c) => c.trim()).filter(Boolean);
  }
  if (!contexts.length) {
    contexts = [...new Set((m.lavorazioni || []).map((l) => l.reparto).filter(Boolean))];
  }
  return {
    anagrafica: m.anagrafica || {},
    agenda: m.agenda || {},
    lavorazioni: m.lavorazioni || [],
    note_interne: m.note_interne || "",
    contexts,
    meta: m.meta || {},
  };
}

export function jobToMapping(job) {
  const sections = job.sections || [];
  const lavorazioni = Array.isArray(sections)
    ? sections.map((s) => ({
        reparto: s.reparto || s.context,
        descrizioni: s.descrizioni || s.description_rows || [],
        ore_man: s.ore_man ?? s.man_hours ?? null,
        ore_mac: s.ore_mac ?? s.mac_hours ?? null,
        materiali_euro: s.materiali_euro ?? s.materials_amount ?? null,
        ricambi: s.ricambi || s.parts || [],
        smaltimento_applica: s.smaltimento_applica ?? s.waste?.apply ?? false,
        smaltimento_percentuale: s.smaltimento_percentuale ?? s.waste?.percentage ?? null,
        note: s.note ?? s.notes ?? null,
      }))
    : Object.entries(sections).map(([reparto, s]) => ({
        reparto,
        descrizioni: s.description_rows || s.descrizioni || [],
        ore_man: s.man_hours ?? s.ore_man ?? null,
        ore_mac: s.mac_hours ?? s.ore_mac ?? null,
        materiali_euro: s.materials_amount ?? s.materiali_euro ?? null,
        ricambi: s.parts || s.ricambi || [],
        smaltimento_applica: s.waste?.apply ?? s.waste_apply ?? false,
        smaltimento_percentuale: s.waste?.percentage ?? s.waste_percentage ?? null,
        note: s.notes ?? s.note ?? null,
      }));

  return {
    anagrafica: {
      targa: job.customer?.plate || job.plate_confirmed || "",
      cliente_nome: job.customer?.name || job.customer_name || "",
      cliente_telefono: job.customer?.phone || job.phone || "",
    },
    agenda: {
      data: job.appointment?.date || job.appointment_date || "",
      ora: (() => {
        const rawTime = job.appointment?.time || job.appointment_time || "";
        return rawTime ? normalizeAppointmentTime(rawTime) : "";
      })(),
      durata_minuti: job.appointment?.duration || job.slot_duration || getYapSlotMinutes(),
      tipo_pratica: job.appointment?.type || job.appointment_type || job.practice_type || "",
    },
    lavorazioni,
    note_interne: job.internalNotes || job.internal_notes || "",
    contexts: job.contexts || [],
    meta: job.meta || {},
  };
}

/** Solo revisione, senza officina/carrozzeria selezionati in mini-app. */
export function isRevisionePura(mapping) {
  const contexts = mapping.contexts || [];
  if (!contexts.length) return false;
  if (contexts.length === 1 && contexts[0] === "revisione") return true;
  return false;
}

export function hasWorkContexts(mapping) {
  const contexts = new Set((mapping.contexts || []).map((ctx) => String(ctx || "").trim().toLowerCase()));
  for (const context of WORK_CONTEXTS) {
    if (contexts.has(context)) return true;
  }
  return false;
}

export function pickWorkPage(mapping) {
  if (!hasWorkContexts(mapping)) return null;
  const tipo = String(mapping.agenda?.tipo_pratica || "").trim().toLowerCase();
  return tipo === "preventivo" ? "preventivi" : "ordini di lavoro";
}

export function collectDescriptionLines(mapping) {
  const lines = [];
  const contexts = new Set(mapping.contexts || []);
  for (const l of sortLavorazioniByReparto(mapping.lavorazioni)) {
    if (contexts.size && !contexts.has(l.reparto)) continue;
    for (const d of l.descrizioni || []) {
      const t = String(d || "").trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

/** Prima riga lavoro utile (es. RIPARARE FORATURA), non generica "Revisione". */
export function pickWorkBrief(mapping) {
  const override = mapping.meta?.cosa_breve || mapping.meta?.work_brief;
  if (override) return String(override).trim().toUpperCase().slice(0, 28);

  for (const line of collectDescriptionLines(mapping)) {
    if (!GENERIC_REVISIONE.test(line)) {
      return line.toUpperCase().slice(0, 28);
    }
  }
  return "";
}

export function pickCosa(mapping) {
  const override = mapping.meta?.cosa_override || mapping.anagrafica?.riferimento_breve;
  if (override) return String(override).trim().toUpperCase().slice(0, 40);

  const plate = String(mapping.anagrafica?.targa || "").trim().toUpperCase();
  if (isRevisionePura(mapping)) return "REVISIONE";

  const brief = pickWorkBrief(mapping);
  if (brief && plate) return `${plate} - ${brief}`.slice(0, 40);
  return plate.slice(0, 40);
}

export function pickCosaFromJob(job) {
  if (job.cosaOverride) return String(job.cosaOverride).trim().toUpperCase().slice(0, 40);
  return pickCosa(jobToMapping(job));
}

/**
 * Tag da contesti mini-app (unica fonte di verità).
 * Non si inferisce nulla dal testo delle righe descrittive.
 */
export function pickYapTags(mapping) {
  const contexts = mapping.contexts || [];
  const tipo = mapping.agenda?.tipo_pratica || "";

  const tags = new Set();
  if (contexts.includes("officina")) tags.add("officina");
  if (contexts.includes("revisione")) tags.add("revisione");
  if (contexts.includes("carrozzeria")) {
    tags.add("pneumatici");
    if (tipo === "preventivo") tags.add("preventivo");
  }
  if (!tags.size && contexts.includes("pneumatici")) tags.add("pneumatici");

  return [...tags];
}

export function pickYapTagsFromJob(job) {
  return pickYapTags(jobToMapping(job));
}

export function yapSlotDuration(mapping) {
  return Number(mapping.agenda?.durata_minuti || mapping.agenda?.slot_duration || getYapSlotMinutes());
}

export function shouldFillPopupNotes() {
  return process.env.YAP_FILL_NOTES === "1";
}

export function buildNotesForPopup(mapping) {
  if (!shouldFillPopupNotes()) return "";
  const lines = [];
  if (mapping.note_interne) lines.push(mapping.note_interne.trim());
  for (const l of mapping.lavorazioni || []) {
    for (const d of l.descrizioni || []) {
      if (d) lines.push(String(d).trim());
    }
  }
  return lines.filter(Boolean).join(" | ").slice(0, 500);
}

function toItalianDate(iso) {
  const [y, m, d] = String(iso || "").slice(0, 10).split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

function toYapTime(time) {
  const raw = String(time || "").trim();
  if (!raw) return "";
  return normalizeAppointmentTime(raw).replace(":", ".");
}

function addMinutes(time, minutes) {
  const [h, m] = String(time || "00:00").split(":").map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m + minutes, 0));
  return `${String(d.getUTCHours()).padStart(2, "0")}.${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function buildManagementPlan(raw) {
  const mapping = normalizeMappingInput(raw);
  const durata = yapSlotDuration(mapping);
  const rawTime = mapping.agenda.ora || mapping.agenda.time || "";
  const ora = rawTime ? normalizeAppointmentTime(rawTime) : "";
  const hasWork = hasWorkContexts(mapping);
  const workPage = pickWorkPage(mapping);
  const workPageLabel = workPage === "preventivi" ? "Preventivi" : "Ordini di lavoro";

  const agenda = {
    cosa: pickCosa(mapping),
    quando: toItalianDate(mapping.agenda.data),
    dalle: toYapTime(ora),
    alle: addMinutes(ora, durata),
    tag: pickYapTags(mapping),
    note: buildNotesForPopup(mapping) || null,
    action: "create_appointment",
    delegatedToYap: hasWork ? ["pratica", "odl_base"] : ["pratica"],
  };

  const contexts = new Set(mapping.contexts || []);
  const lavorazioni = hasWork ? sortLavorazioniByReparto(mapping.lavorazioni)
    .filter((l) => !contexts.size || contexts.has(l.reparto))
    .map((l) => {
      const noteReparto = String(l.note || l.notes || "").trim();
      return {
        reparto: l.reparto,
        descrizioni: l.descrizioni || l.description_rows || [],
        ore_man: l.ore_man ?? l.man_hours ?? null,
        ore_mac: l.ore_mac ?? l.mac_hours ?? null,
        materiali_euro: l.materiali_euro ?? l.materials_amount ?? null,
        ricambi: l.ricambi || l.parts || [],
        smaltimento: {
          applica: l.smaltimento_applica ?? l.waste?.apply ?? false,
          percentuale: l.smaltimento_percentuale ?? l.waste?.percentage ?? null,
        },
        noteReparto: noteReparto || null,
        yapSezione: "Gestione pratica › Ordini di lavoro",
        writeTargets: {
          descrizioni: "ODL › righe lavoro",
          ore_man: "ODL › MANODOPERA › ore uomo (MAN)",
          ore_mac: "ODL › MANODOPERA › ore macchina (MAC)",
          materiali_euro: "ODL › MATERIALI DI CONSUMO",
          ricambi: "ODL › articoli magazzino",
          smaltimento: "Gestione pratica › Smaltimento rifiuti",
          note: "Gestione pratica › note reparto",
        },
        giorgioWorkerPhase: "odl_v2_planned",
        note: noteReparto || "Destinazioni ODL definite; worker Giorgio da estendere dopo agenda",
      };
    }) : [];

  return {
    mode: "shadow_plan_no_yap_write",
    practiceId: mapping.meta?.practice_id || null,
    anagrafica: {
      cliente: mapping.anagrafica.cliente_nome || mapping.anagrafica.cliente,
      telefono: mapping.anagrafica.cliente_telefono || mapping.anagrafica.telefono,
      targa: mapping.anagrafica.targa,
    },
    agenda,
    gestione_pratica: {
      action: "skip_automation",
      reason: hasWork
        ? "Gestione pratica nativa YAP dopo save appuntamento"
        : "Solo revisione: nessun passaggio su Preventivi/ODL",
      fieldsFromGiorgio: ["cliente", "telefono", "targa"],
    },
    odl: hasWork ? {
      action: "mapping_complete_worker_planned",
      page: workPage,
      pageLabel: workPageLabel,
      reason: `Base ${workPageLabel} da AutomatismoOdlDaPrenotazione; MAN/MAC/materiali/ricambi → ${workPageLabel}`,
      yapMenu: [workPageLabel, "Materiali di consumo", "Smaltimento rifiuti", "Revisione"],
      lavorazioniGiorgio: lavorazioni,
      yapPopulates: ["revisione_righe", "manodopera_catalog", "materiali_consumo"],
    } : null,
    confidence: {
      agenda: "high",
      gestione_pratica: "medium",
      odl: hasWork ? "medium" : "n/a",
    },
    dedupKey: [String(mapping.anagrafica.targa || "").toUpperCase(), String(mapping.agenda.data || "").slice(0, 10), String(ora).replace(".", ":").slice(0, 5)]
      .filter(Boolean)
      .join("|"),
    fieldMapping: buildFullFieldMapping(mapping),
  };
}

/** Anteprima completa agenda + piano ODL (senza browser). */
export function buildYapPreview(mapping, preSync = null) {
  const plan = buildManagementPlan({ mapping });
  const durata = yapSlotDuration(mapping);

  return {
    mode: "preview_only_no_yap_write",
    giorgioSummary: {
      cliente: mapping.anagrafica?.cliente_nome,
      telefono: mapping.anagrafica?.cliente_telefono,
      targa: mapping.anagrafica?.targa,
      data: mapping.agenda?.data,
      ora: plan.agenda.dalle ? plan.agenda.dalle.replace(".", ":") : (mapping.agenda?.ora || mapping.agenda?.time),
      durata_minuti: durata,
      contesti: mapping.contexts || [],
      tipo_pratica: mapping.agenda?.tipo_pratica,
      cosa_breve: pickWorkBrief(mapping) || null,
      note_interne: mapping.note_interne || null,
    },
    proposedYap: {
      popup: {
        cosa: plan.agenda.cosa,
        quando: plan.agenda.quando,
        dalle: plan.agenda.dalle,
        alle: plan.agenda.alle,
        tag: plan.agenda.tag,
        note1_proposed: null,
      },
      delegatedToYap: plan.agenda.delegatedToYap,
      gestionePratica: plan.gestione_pratica,
      odl: plan.odl,
      fieldMapping: plan.fieldMapping,
    },
    preSync,
    confidence: {
      cosa: isRevisionePura(mapping) ? "high" : "indicative",
      cosaNote: isRevisionePura(mapping)
        ? null
        : "YAP compone titolo/barra agenda; Cosa popup è best-effort da dati mini-app",
      tag: plan.agenda.tag.length ? "high" : "low",
      write_ready: Boolean(preSync?.ready),
    },
  };
}
