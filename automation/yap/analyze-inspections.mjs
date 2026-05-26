#!/usr/bin/env node
/**
 * Consolida ispezioni YAP (precise, deep, supplement) e genera:
 *   - yap-field-mapping.json
 *   - yap-reparto-mapping.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(__dirname, "analysis");

function parseArgs(argv) {
  const args = { analysisDir: ANALYSIS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--analysis-dir") args.analysisDir = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Uso: node automation/yap/analyze-inspections.mjs [--analysis-dir DIR]");
      process.exit(0);
    }
  }
  return args;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function classifyInputRole(input, index, allInputs) {
  const value = String(input.value || "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return "quando";
  if (/^\d{1,2}\.\d{2}$/.test(value)) {
    const timeInputs = allInputs.filter((i) => /^\d{1,2}\.\d{2}$/.test(String(i.value || "").trim()));
    const pos = timeInputs.findIndex((i) => i === input);
    return pos === 0 ? "dalle" : "alle";
  }
  if (index === 0 || (!/^\d/.test(value) && value.length <= 12 && /^[A-Z0-9]+$/i.test(value))) {
    return "cosa";
  }
  if (!value && index >= 4 && index <= 5) return "note";
  return "unknown";
}

function normalizeAppointmentRecord(source, record) {
  const target = record.target || {};
  const popup = record.popup || {};
  const inputs = popup.inputs || [];
  const visibleInputs = inputs.filter((i) => i.hidden !== true);

  const fields = visibleInputs.map((input, index) => ({
    role: classifyInputRole(input, index, visibleInputs),
    name: input.name,
    id: input.id,
    value: input.value,
    type: input.type,
  }));

  const cosa = fields.find((f) => f.role === "cosa")?.value || "";
  const quando = fields.find((f) => f.role === "quando")?.value || "";
  const dalle = fields.find((f) => f.role === "dalle")?.value || "";
  const alle = fields.find((f) => f.role === "alle")?.value || "";
  const tagChips = popup.tagChips || extractTagsFromRaw(popup.rawText);

  return {
    source,
    id: target.id,
    name: target.name,
    date: target.date,
    giorgioContext: target.context || null,
    found: record.found !== false,
    agendaTitle: record.text || record.clickedEvent?.text || "",
    repartoClass: record.repartoClass || record.clickedEvent?.repartoClass || "",
    fields: { cosa, quando, dalle, alle },
    tagChips,
    fieldDetails: fields,
  };
}

function extractTagsFromRaw(rawText) {
  if (!Array.isArray(rawText)) return [];
  const known = ["pneumatici", "revisione", "comunicato", "preventivo", "tagliando", "meccanica", "officina", "carrozzeria"];
  const blob = rawText.join(" ").toLowerCase();
  return known.filter((tag) => blob.includes(tag));
}

function loadAllAppointments(analysisDir) {
  const appointments = [];

  const precise = readJsonIfExists(path.join(analysisDir, "precise-inspection-results.json"));
  const deep = readJsonIfExists(path.join(analysisDir, "deep-inspection-results.json"));
  const supplement = readJsonIfExists(path.join(analysisDir, "supplement-inspection-results.json"));

  return Promise.all([precise, deep, supplement]).then(([preciseData, deepData, supplementData]) => {
    if (preciseData?.results) {
      for (const r of preciseData.results) {
        if (r.found) appointments.push(normalizeAppointmentRecord("precise", r));
      }
    }
    if (deepData?.results) {
      for (const r of deepData.results) {
        if (r.type === "appointment" && r.found) {
          const merged = {
            ...r,
            popup: {
              inputs: r.popup?.inputs,
              tagChips: r.popup?.tagChips,
              rawText: r.popup?.rawVisibleText?.split("|").map((t) => t.trim()),
            },
          };
          appointments.push(normalizeAppointmentRecord("deep", merged));
        }
      }
    }
    if (supplementData?.results) {
      for (const r of supplementData.results) {
        if (r.found) appointments.push(normalizeAppointmentRecord("supplement", r));
      }
    }

    const byKey = new Map();
    for (const item of appointments) {
      const key = `${item.id || item.name}-${item.date}`;
      if (!byKey.has(key) || item.source === "deep") {
        byKey.set(key, item);
      }
    }
    return [...byKey.values()];
  });
}

function buildRepartoMapping(appointments, legendReport) {
  const classStats = {};
  for (const appt of appointments) {
    if (!appt.repartoClass) continue;
    const entry = classStats[appt.repartoClass] || {
      repartoClass: appt.repartoClass,
      examples: [],
      giorgioContexts: new Set(),
      yapTags: new Set(),
    };
    entry.examples.push({
      name: appt.name,
      date: appt.date,
      giorgioContext: appt.giorgioContext,
      tagChips: appt.tagChips,
      agendaTitle: appt.agendaTitle?.slice(0, 100),
    });
    if (appt.giorgioContext) entry.giorgioContexts.add(appt.giorgioContext);
    for (const tag of appt.tagChips || []) entry.yapTags.add(tag);
    classStats[appt.repartoClass] = entry;
  }

  const observed = legendReport?.observedClasses || [];
  for (const obs of observed) {
    const entry = classStats[obs.repartoClass] || {
      repartoClass: obs.repartoClass,
      examples: [],
      giorgioContexts: new Set(),
      yapTags: new Set(),
    };
    entry.observedOnAgenda = {
      count: obs.count,
      bgColors: obs.bgColors,
      borderColors: obs.borderColors,
      sampleTitles: obs.sampleTitles,
    };
    classStats[obs.repartoClass] = entry;
  }

  return {
    version: "2026-05",
    analyzedAt: new Date().toISOString(),
    note: "Colonna agenda (CSS) e tag popup sono sistemi distinti. Non mappare carrozzeria→officina in modo automatico.",
    cssColumnClasses: Object.values(classStats).map((e) => ({
      repartoClass: e.repartoClass,
      observedOnAgenda: e.observedOnAgenda || null,
      giorgioContextsSeen: [...e.giorgioContexts],
      yapTagsSeen: [...e.yapTags],
      examples: e.examples.slice(0, 3),
      inferredLabel: legendReport?.inferredMapping?.[e.repartoClass]?.label || "da confermare",
    })),
    giorgioContextToYapTags: {
      officina: {
        primaryTags: ["officina"],
        fallbackTags: [],
        confidence: "medium-high",
        note: "Categoria O confermata via RPC (DP126GZ). Non usare meccanica leggera/pesante: non sono reparti cliente.",
      },
      carrozzeria: {
        primaryTags: ["pneumatici"],
        fallbackTags: ["preventivo", "comunicato"],
        confidence: "high",
        note: "Italtrans e Porta posteriore usano pneumatici; Frigor usa revisione nel tag.",
      },
      revisione: {
        primaryTags: ["revisione"],
        fallbackTags: [],
        confidence: "high",
        note: "Passat misto mostra solo tag revisione nel popup.",
      },
      misto: {
        primaryTags: ["revisione", "pneumatici"],
        strategy: "single_appointment_multi_tag",
        confidence: "medium",
        note: "Un appuntamento puo avere piu chip (es. Porta: pneumatici+comunicato+preventivo).",
      },
    },
    observedAppointments: appointments.map((a) => ({
      name: a.name,
      date: a.date,
      giorgioContext: a.giorgioContext,
      repartoClass: a.repartoClass,
      tagChips: a.tagChips,
      cosa: a.fields.cosa,
    })),
  };
}

function buildFieldMapping(appointments) {
  const cosaExamples = appointments.map((a) => a.fields.cosa).filter(Boolean);
  const uniqueTags = [...new Set(appointments.flatMap((a) => a.tagChips || []))];

  return {
    yapVersion: "2026-05",
    analyzedAt: new Date().toISOString(),
    sources: ["precise-inspection-results.json", "deep-inspection-results.json", "supplement-inspection-results.json"],
    popupStructure: {
      title: "Dettagli appuntamento",
      inputCount: 7,
      textareaCount: 0,
      selectCount: 0,
      fieldOrder: ["cosa", "quando", "dalle", "alle", "note1", "note2", "tag"],
      detectionMethod: "position_and_value_pattern",
      stableInSession: true,
      gwtNamesObfuscated: true,
    },
    fields: {
      cosa: {
        yapLabel: "Cosa",
        giorgioFields: ["anagrafica.targa"],
        transform: "uppercase",
        required: true,
        examples: cosaExamples,
        note: "In YAP reale il campo Cosa contiene spesso solo targa/riferimento breve, non il titolo agenda completo.",
      },
      quando: {
        yapLabel: "Quando",
        giorgioFields: ["agenda.data"],
        transform: "DD/MM/YYYY",
        required: true,
      },
      dalle: {
        yapLabel: "dalle",
        giorgioFields: ["agenda.ora"],
        transform: "HH.MM",
        required: true,
      },
      alle: {
        yapLabel: "alle",
        giorgioFields: ["agenda.ora", "agenda.durata_minuti"],
        transform: "end_time_HH.MM",
        required: true,
        defaultDurationMinutes: 20,
      },
      note1: { yapLabel: "(campo vuoto 1)", giorgioFields: ["note_interne"], required: false, status: "unmapped" },
      note2: { yapLabel: "(campo vuoto 2)", giorgioFields: ["lavorazioni.descrizioni"], required: false, status: "unmapped" },
      tag: {
        yapLabel: "Tag",
        giorgioFields: ["lavorazioni.reparto", "contexts"],
        type: "chip_multi",
        knownTags: uniqueTags,
        addMethod: "ui_chip_click_or_combobox",
        required: false,
      },
    },
    agendaBarTitle: {
      format: "{timeRange}{plate} - {model} - {client} - {phone} - {plateOrRef}",
      giorgioMapping: {
        plate: "anagrafica.targa",
        client: "anagrafica.cliente_nome",
        phone: "anagrafica.cliente_telefono",
        model: "veicolo.modello (se disponibile)",
      },
      workerStrategy: "cosa=targa; titolo barra compilato da YAP o note aggiuntive post-save",
      examples: appointments.map((a) => a.agendaTitle).filter(Boolean).slice(0, 4),
    },
    workSections: {
      detectionStatus: "NOT_YET_MAPPED",
      desiredFields: ["ore_man", "ore_mac", "materiali_euro", "smaltimento", "ricambi"],
    },
    inspectedAppointments: appointments,
    workerRules: [
      "Usare pattern valore (data/ora) per trovare indici input, non name GWT.",
      "Campo Cosa = targa uppercase.",
      "Tag = chip UI; non scrivere 'officina'/'carrozzeria' come testo libero.",
      "Navigare data con click mese/giorno, non page.goto su #!agenda dopo login.",
      "Casi misti: aggiungere piu tag chip quando supportato.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("📁 Analisi directory:", args.analysisDir);

  const appointments = await loadAllAppointments(args.analysisDir);
  const legendReport = await readJsonIfExists(path.join(args.analysisDir, "yap-legend-report.json"));

  if (appointments.length === 0) {
    console.error("❌ Nessuna ispezione trovata. Esegui prima yap-precise-inspector o yap-deep-inspector.");
    process.exit(1);
  }

  const fieldMapping = buildFieldMapping(appointments);
  const repartoMapping = buildRepartoMapping(appointments, legendReport);

  const fieldPath = path.join(args.analysisDir, "yap-field-mapping.json");
  const repartoPath = path.join(args.analysisDir, "yap-reparto-mapping.json");

  await fs.writeFile(fieldPath, JSON.stringify(fieldMapping, null, 2), "utf8");
  await fs.writeFile(repartoPath, JSON.stringify(repartoMapping, null, 2), "utf8");

  console.log(`✅ ${appointments.length} appuntamenti consolidati`);
  console.log(`   ${fieldPath}`);
  console.log(`   ${repartoPath}`);
  console.log(`   Tag osservati: ${[...new Set(appointments.flatMap((a) => a.tagChips))].join(", ")}`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
