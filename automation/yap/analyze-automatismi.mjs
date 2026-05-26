#!/usr/bin/env node
/**
 * Estrae automatismi YAP da trace RPC (AllContextsGetAction + PropertyGetAction).
 * Read-only: analizza file già raccolti.
 *
 * Uso:
 *   node analyze-automatismi.mjs [trace1.json trace2.json ...]
 *   node analyze-automatismi.mjs   # default: tutti rpc-trace-*.json in analysis/
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

const AUTOMATISMO_RE = /Automatismo[\w]+/g;
const AUTOMATISMO_CLASS_RE = /it\.indacosoftware\.yap\.shared\.models\.(Automatismo[\w/]+)/g;

const KNOWN_TAGS = new Set([
  "officina",
  "carrozzeria",
  "pneumatici",
  "revisione",
  "preventivo",
  "comunicato",
  "tagliando",
  "tagliando base",
  "tagliando completo",
  "perizia",
  "fattura",
  "man",
]);

function parseGwt(text) {
  if (!text || !text.startsWith("//OK")) return null;
  try {
    return JSON.parse(text.slice(4));
  } catch {
    return null;
  }
}

function findStringTable(arr) {
  if (!Array.isArray(arr)) return [];
  let best = [];
  for (const v of arr) {
    if (Array.isArray(v) && v.length > best.length && v.every((x) => typeof x === "string")) {
      best = v;
    }
  }
  return best;
}

function shortClass(s) {
  const m = String(s).match(/Automatismo[\w]+/);
  return m ? m[0] : s;
}

function extractAutomatismiFromTable(table) {
  const automatismi = [];
  for (let i = 0; i < table.length; i += 1) {
    const cell = table[i];
    if (!String(cell).includes("Automatismo")) continue;

    const name = shortClass(cell);
    const contextBefore = [];
    const contextAfter = [];

    for (let j = Math.max(0, i - 8); j < i; j += 1) {
      const v = String(table[j] || "").trim();
      if (v && !v.startsWith("it.") && !v.startsWith("java.") && !v.startsWith("com.") && v.length < 60) {
        contextBefore.push(v);
      }
    }
    for (let j = i + 1; j < Math.min(table.length, i + 12); j += 1) {
      const v = String(table[j] || "").trim();
      if (v && !v.startsWith("it.") && !v.startsWith("java.") && !v.startsWith("com.") && v.length < 60) {
        contextAfter.push(v);
      }
    }

    const nearbyTags = [...contextBefore, ...contextAfter].filter(
      (t) =>
        KNOWN_TAGS.has(t.toLowerCase()) ||
        /^(tagliando|revisione|preventivo|comunicato|officina|carrozzeria|pneumatici)/i.test(t),
    );

    automatismi.push({
      className: cell,
      shortName: name,
      index: i,
      contextBefore: contextBefore.slice(-5),
      contextAfter: contextAfter.slice(0, 8),
      likelyTags: [...new Set(nearbyTags)],
    });
  }
  return automatismi;
}

function extractTagContexts(table) {
  const contexts = [];
  const reparti = ["officina", "carrozzeria", "pneumatici"];
  for (let i = 0; i < table.length; i += 1) {
    const cell = String(table[i] || "").toLowerCase();
    if (!reparti.includes(cell)) continue;
    const tags = [];
    for (let j = i + 1; j < Math.min(table.length, i + 20); j += 1) {
      const v = String(table[j] || "").trim();
      if (v.startsWith("it.indacosoftware.yap.shared.models.Automatismo")) break;
      if (v.startsWith("it.") || v.startsWith("java.") || v.startsWith("com.")) continue;
      if (v && v.length < 40 && !/^v\d/.test(v)) tags.push(v);
    }
    contexts.push({ reparto: cell, index: i, nearbyTags: tags.slice(0, 15) });
  }
  return contexts;
}

function extractPropertyHints(table) {
  const hints = [];
  const keywords = [
    "Pratica",
    "ODL",
    "MANODOPERA",
    "MATERIALI",
    "Automatismo",
    "prenotazione",
    "tagContext",
    "TagEntry",
  ];
  for (let i = 0; i < table.length; i += 1) {
    const cell = String(table[i] || "");
    if (!keywords.some((k) => cell.includes(k))) continue;
    hints.push({
      index: i,
      value: cell.length > 200 ? `${cell.slice(0, 200)}…` : cell,
      neighbors: table.slice(Math.max(0, i - 2), i + 3).filter((x) => typeof x === "string"),
    });
  }
  return hints.slice(0, 80);
}

async function analyzeTrace(filePath) {
  const trace = JSON.parse(await fs.readFile(filePath, "utf8"));
  const action = (url) => String(url || "").split("/").pop();

  const allContexts = trace.traces?.filter(
    (t) => t.direction === "response" && action(t.url) === "AllContextsGetAction" && t.decoded?.stringTable?.length,
  ) || [];

  const propertyGets = trace.traces?.filter(
    (t) => t.direction === "response" && action(t.url) === "PropertyGetAction" && (t.length > 5000 || t.decoded?.stringTable?.length > 100),
  ) || [];

  let automatismi = [];
  let tagContexts = [];
  let propertyHints = [];

  for (const r of allContexts) {
    const table = r.decoded?.stringTable || findStringTable(parseGwt(r.decoded?.raw));
    automatismi.push(...extractAutomatismiFromTable(table));
    tagContexts.push(...extractTagContexts(table));
  }

  for (const r of propertyGets) {
    const table = r.decoded?.stringTable || findStringTable(parseGwt(r.decoded?.raw));
    propertyHints.push(...extractPropertyHints(table));
  }

  // dedupe automatismi by shortName
  const byName = new Map();
  for (const a of automatismi) {
    const prev = byName.get(a.shortName);
    if (!prev || a.likelyTags.length > prev.likelyTags.length) {
      byName.set(a.shortName, a);
    }
  }

  return {
    file: path.basename(filePath),
    meta: trace.meta || {},
    allContextsResponses: allContexts.length,
    propertyGetResponses: propertyGets.length,
    automatismi: [...byName.values()],
    tagContexts: tagContexts.slice(0, 10),
    propertyHintsCount: propertyHints.length,
    propertyHintsSample: propertyHints.slice(0, 15),
    hasManodopera: propertyHints.some((h) => h.value.includes("MANODOPERA")),
  };
}

function buildFindings(perTrace) {
  const allAutomatismi = new Map();
  for (const t of perTrace) {
    for (const a of t.automatismi) {
      const prev = allAutomatismi.get(a.shortName) || { ...a, sources: [] };
      prev.sources = [...new Set([...prev.sources, t.file])];
      prev.likelyTags = [...new Set([...(prev.likelyTags || []), ...(a.likelyTags || [])])];
      allAutomatismi.set(a.shortName, prev);
    }
  }

  const automatismiList = [...allAutomatismi.values()].map((a) => ({
    name: a.shortName,
    className: a.className,
    likelyTriggerTags: a.likelyTags,
    sources: a.sources,
    giorgioRelevance: inferRelevance(a.shortName, a.likelyTags),
  }));

  const scopeDecision = inferScopeDecision(automatismiList);

  return {
    generatedAt: new Date().toISOString(),
    method: "analyze-automatismi.mjs on existing RPC traces",
    sources: perTrace.map((t) => t.file),
    summary: scopeDecision.summary,
    automatismi: automatismiList,
    tagContextsObserved: perTrace.flatMap((t) => t.tagContexts).slice(0, 15),
    propertyEvidence: {
      hasManodoperaCatalog: perTrace.some((t) => t.hasManodopera),
      note: "PropertyGetAction espone catalogo MANODOPERA e CausaleAutomatismo — YAP ha infrastruttura ODL/magazzino nativa.",
    },
    scopeDecision,
    implicationsForGiorgio: buildImplications(automatismiList, scopeDecision),
    nextSteps: [
      "Verificare read-only su appuntamento con tag revisione/tagliando se esiste ODL collegato",
      "Non implementare ODL manuale finché non si conferma che gli automatismi non coprono il caso",
      "Priorità agenda: tag chip corretti (officina, revisione, preventivo+comunicato) — YAP potrebbe propagare il resto",
      "Settimana scraping RPC per correlare tag→categoria→automatismi su N appuntamenti reali",
    ],
    confidence: "high (classi automatismo presenti nel tenant); medium (trigger esatti per ogni tag)",
  };
}

function inferRelevance(name, tags) {
  const map = {
    AutomatismoOdlDaPrenotazione: "ODL creato automaticamente da prenotazione — riduce scope ODL",
    AutomatismoArticoloDocumentoFromTagPrenotazione: "Righe documento/articoli da tag prenotazione — riduce scope materiali/ricambi",
    AutomatismoControlloInPrenotazione: "Controllo automatico in prenotazione",
    AutomatismoRevisioneInPrenotazione: "Revisione automatica — tag revisione importante",
    AutomatismoInterventoAppDrive: "Integrazione AppDrive — fuori scope Giorgio",
    AutomatismoFatturaElettronicaPush: "Fattura elettronica — fuori scope agenda",
    AutomatismoFatturaElettronicaMittenteDestinatario: "FE mittente/destinatario — fuori scope agenda",
  };
  return map[name] || `Automatismo generico; tag vicini: ${tags.join(", ") || "n/d"}`;
}

function inferScopeDecision(automatismiList) {
  const odl = automatismiList.find((a) => a.name === "AutomatismoOdlDaPrenotazione");
  const articoli = automatismiList.find((a) => a.name === "AutomatismoArticoloDocumentoFromTagPrenotazione");
  const revisione = automatismiList.find((a) => a.name === "AutomatismoRevisioneInPrenotazione");

  const odlLikelyDelegated = Boolean(odl);
  const articoliLikelyDelegated = Boolean(articoli);
  const revisioneLikelyDelegated = Boolean(revisione);

  let summary;
  if (odlLikelyDelegated && articoliLikelyDelegated) {
    summary =
      "YAP ha automatismi nativi ODL + articoli da tag prenotazione. Probabile che impostando i tag agenda corretti YAP crei pratica/ODL/righe senza automazione UI aggiuntiva. Scope Giorgio: focus su agenda + tag, non su ODL manuale.";
  } else if (odlLikelyDelegated) {
    summary = "ODL da prenotazione presente nel tenant. Articoli da tag incerto. Scope parziale delegato a YAP.";
  } else {
    summary = "Automatismi ODL non trovati nei trace — serve discovery aggiuntiva.";
  }

  return {
    summary,
    delegateOdlToYap: odlLikelyDelegated,
    delegateArticoliToYap: articoliLikelyDelegated,
    delegateRevisioneToYap: revisioneLikelyDelegated,
    giorgioMustImplement: {
      agenda: true,
      tagChips: true,
      gestionePraticaManual: !odlLikelyDelegated,
      odlManual: !odlLikelyDelegated,
      oreMaterialiRicambiManual: !(odlLikelyDelegated && articoliLikelyDelegated),
    },
    revisedScopePercent: {
      agenda: "70-75%",
      gestionePratica: odlLikelyDelegated ? "30-40% (YAP auto, verificare campi residui)" : "5-10%",
      odl: odlLikelyDelegated ? "20-35% (YAP auto da tag, verificare ore/materiali)" : "5-10%",
      fullFlow: odlLikelyDelegated ? "45-55%" : "35-45%",
    },
  };
}

function buildImplications(automatismiList, scopeDecision) {
  const items = [
    "Giorgio deve concentrarsi su: targa (Cosa), data/ora, tag chip corretti per reparto.",
    "Ore, materiali, ricambi: NON in agenda popup — flusso cliente = gestione pratica → ODL.",
  ];
  if (scopeDecision.delegateOdlToYap) {
    items.push(
      "Se AutomatismoOdlDaPrenotazione è attivo: creare appuntamento con tag giusti potrebbe bastare per ODL base.",
      "Tag osservati vicino a ODL automatismo: tagliando base, tagliando completo, pneumatici.",
    );
  }
  if (scopeDecision.delegateArticoliToYap) {
    items.push(
      "AutomatismoArticoloDocumentoFromTagPrenotazione: tag prenotazione possono generare righe documento/magazzino.",
    );
  }
  const rev = automatismiList.find((a) => a.name === "AutomatismoRevisioneInPrenotazione");
  if (rev) {
    items.push("Tag 'revisione' collegato ad automatismo revisione — conferma mapping R007.");
  }
  return items;
}

async function main() {
  let files = process.argv.slice(2);
  if (!files.length) {
    const all = await fs.readdir(ANALYSIS);
    files = all.filter((f) => f.startsWith("rpc-trace-") && f.endsWith(".json")).map((f) => path.join(ANALYSIS, f));
  } else {
    files = files.map((f) => path.resolve(f));
  }

  if (!files.length) {
    console.error("Nessun trace trovato. Eseguire prima yap-rpc-interceptor.mjs");
    process.exit(1);
  }

  const perTrace = [];
  for (const f of files) {
    console.log(`Analizzo ${path.basename(f)}…`);
    perTrace.push(await analyzeTrace(f));
  }

  const findings = buildFindings(perTrace);
  const outPath = path.join(ANALYSIS, "yap-automatismi-findings.json");
  await fs.writeFile(outPath, JSON.stringify(findings, null, 2), "utf8");

  console.log("\n=== Automatismi YAP ===");
  for (const a of findings.automatismi) {
    console.log(`  ${a.name}`);
    if (a.likelyTriggerTags.length) console.log(`    tag: ${a.likelyTriggerTags.join(", ")}`);
    console.log(`    → ${a.giorgioRelevance}`);
  }
  console.log("\n=== Decisione scope ===");
  console.log(findings.scopeDecision.summary);
  console.log(`\n📄 ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
