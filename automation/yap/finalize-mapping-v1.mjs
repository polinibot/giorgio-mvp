#!/usr/bin/env node
/**
 * Congela Mapping v1 da evidenze consolidate + cross-check.
 * Output:
 *   analysis/yap-giorgio-bridge-mapping-v1.json
 *   READONLY_FINAL_REPORT.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));
const ANALYSIS = path.join(DIR, "analysis");

async function read(name) {
  return JSON.parse(await fs.readFile(path.join(ANALYSIS, name), "utf8"));
}

function rule(id, partial) {
  return { ruleId: id, ...partial };
}

function buildRules(evidence, apiIndex) {
  const byExample = {};
  for (const r of evidence.records) {
    if (r.giorgioExampleId) {
      byExample[r.giorgioExampleId] = byExample[r.giorgioExampleId] || [];
      byExample[r.giorgioExampleId].push(r);
    }
  }

  const popupRecords = evidence.records.filter((r) => r.uiStatus === "popup_extracted");
  const cosaPlateCount = popupRecords.filter((r) => {
    const plateLike = /^[A-Z0-9]{5,8}$/i.test(r.popup?.cosa || "");
    return plateLike;
  }).length;
  const cosaException = popupRecords.filter((r) => r.popup?.cosa === "RADWAN");

  return [
    rule("R001_cosa_targa_default", {
      giorgioPath: "anagrafica.targa",
      yapTarget: "popup.cosa",
      transform: "uppercase(trim)",
      state: "accepted",
      confidence: "high",
      evidence: popupRecords.filter((r) => /^[A-Z0-9]{5,8}$/i.test(r.popup?.cosa || "")).map((r) => r.id),
      counterexample: cosaException.map((r) => ({ id: r.id, cosa: r.popup.cosa, note: "Passat misto" })),
      decision: "Default: Cosa = targa. Eccezione documentata: riferimento breve (RADWAN) su casi misti.",
      implementation: "if contexts includes misto and shortRef provided -> use shortRef else plate",
    }),
    rule("R002_quando", {
      giorgioPath: "agenda.data",
      yapTarget: "popup.quando",
      transform: "DD/MM/YYYY",
      state: "accepted",
      confidence: "high",
      evidence: popupRecords.map((r) => r.id),
    }),
    rule("R003_dalle_alle", {
      giorgioPath: "agenda.ora + agenda.durata_minuti",
      yapTarget: "popup.dalle / popup.alle",
      transform: "HH.MM, durata default 20",
      state: "accepted",
      confidence: "high",
      evidence: popupRecords.map((r) => r.id),
      note: "Verificare allineamento data popup vs data agenda (alcuni popup mostrano mese diverso)",
    }),
    rule("R004_tag_revisione", {
      giorgioPath: "lavorazioni[].reparto=revisione OR contexts includes revisione",
      yapTarget: "popup.tag chip",
      yapTags: ["revisione"],
      state: "accepted",
      confidence: "high",
      evidence: popupRecords.filter((r) => r.popup?.tagChips?.includes("revisione")).map((r) => r.id),
    }),
    rule("R005_tag_carrozzeria", {
      giorgioPath: "lavorazioni[].reparto=carrozzeria",
      yapTarget: "popup.tag chip",
      yapTags: ["pneumatici"],
      extraTagsIfPreventivo: ["preventivo"],
      manualTagsAfterCustomerAction: ["comunicato"],
      state: "accepted",
      confidence: "medium",
      evidence: popupRecords
        .filter((r) => r.popup?.tagChips?.includes("pneumatici"))
        .map((r) => r.id),
      counterexample: popupRecords
        .filter((r) => r.giorgioExampleId === 1 && r.popup?.tagChips?.includes("revisione"))
        .map((r) => ({ id: r.id, tags: r.popup.tagChips, note: "Frigor carrozzeria -> revisione" })),
      decision: "Usare pneumatici; aggiungere preventivo se tipo_pratica=preventivo. Non aggiungere comunicato automaticamente: resta manuale dopo invio preventivo al cliente.",
    }),
    rule("R006_tag_officina", {
      giorgioPath: "lavorazioni[].reparto=officina",
      yapTarget: "popup.tag chip",
      yapTags: ["officina"],
      state: "accepted",
      confidence: "medium-high",
      evidence: evidence.records
        .filter((r) => r.giorgioExampleId === 2)
        .map((r) => r.id),
      agendaBarProof: {
        date: "2025-04-04",
        title: "DP126GZ ... KIT FRIZIONE",
        repartoClass: "LCWVQRD-b-e",
        note: "Popup officina non estratto; titolo barra conferma pattern",
      },
      apiProof: apiIndex[2] || { bestScore: 0, note: "non in YAP 2026-03-20" },
      decision: "Cosa=targa. Tag chip officina. Categoria O confermata via RPC su DP126GZ.",
    }),
    rule("R007_misto", {
      giorgioPath: "contexts length > 1",
      yapTarget: "popup.tag chip",
      yapTags: ["revisione"],
      state: "accepted",
      confidence: "medium",
      evidence: popupRecords.filter((r) => r.giorgioExampleId === 5).map((r) => r.id),
      decision: "Passat: un appuntamento, un solo tag revisione in YAP. Strategia: un appuntamento + tag revisione + eventuali altri tag se UI lo consente.",
    }),
    rule("R008_note_fields", {
      giorgioPath: "note_interne / lavorazioni.descrizioni",
      yapTarget: "popup.note1 / note2",
      state: "blocked",
      confidence: "none",
      decision: "Campi note popup sempre vuoti nelle ispezioni. Non mappare finche non si vede un esempio valorizzato.",
    }),
    rule("R009_work_sections", {
      giorgioPath: "ore_man, materiali, ricambi",
      yapTarget: null,
      state: "blocked",
      confidence: "none",
      decision: "Non presenti nel popup agenda. Modulo diverso o post-creazione.",
    }),
    rule("R010_cofano_revisione", {
      giorgioPath: "esempio id 9",
      yapTarget: "n/a",
      state: "blocked",
      confidence: "none",
      evidence: ["precise-9-2026-03-15-missing", "readonly-scan-2026-03-15.json"],
      apiProof: apiIndex[9] || {},
      decision: "Non in agenda UI 15/03/2026. Non pianificare inserimento su quella data finche non compare in YAP.",
    }),
    rule("R011_agenda_bar", {
      giorgioPath: "anagrafica + veicolo",
      yapTarget: "agendaBar.title",
      state: "accepted",
      confidence: "high",
      decision: "Composto da YAP automaticamente; non scrivere manualmente in fase 1.",
      pattern: "{time}{plate} - {model} - {client} - {phone} - {suffix}",
    }),
    rule("R012_column_css", {
      giorgioPath: "lavorazioni.reparto",
      yapTarget: "agendaColumn LCWVQRD-b-*",
      state: "proposed",
      confidence: "medium",
      decision: "Colonna CSS != tag. b-f giallo, b-r azzurro, b-e giallo alternativo. Non usare per decidere tag.",
    }),
  ];
}

function buildExampleStatus(byExample, apiIndex) {
  return [
    { id: 1, title: "Frigor", giorgioContext: "carrozzeria", yapTags: ["revisione"], status: "mapped_with_exception", action: "Confermare se carrozzeria deve forzare pneumatici" },
    { id: 2, title: "Kit frizione", giorgioContext: "officina", yapDate: "2025-04-04", giorgioDate: "2026-03-20", status: "historical_reference", action: "Usare 2025-04-04 per studio; non cercare su 20/03/2026" },
    { id: 5, title: "Passat", giorgioContext: "misto", yapTags: ["revisione"], cosa: "RADWAN", status: "mapped_with_exception" },
    { id: 7, title: "Porta posteriore", giorgioContext: "carrozzeria", yapTags: ["pneumatici", "comunicato", "preventivo"], status: "best_aligned" },
    { id: 8, title: "Italtrans", giorgioContext: "carrozzeria", yapTags: ["pneumatici"], status: "best_aligned" },
    { id: 9, title: "Cofano revisione", giorgioContext: "revisione", status: "blocked_not_in_ui", api: apiIndex[9] },
  ];
}

function buildMarkdown(v1) {
  const lines = [
    "# Report finale studio read-only YAP",
    "",
    `Generato: ${v1.frozenAt}`,
    "",
    "## Stato Mapping v1",
    "",
    "| Stato | Regole |",
    "|-------|--------|",
    `| accepted | ${v1.rules.filter((r) => r.state === "accepted").length} |`,
    `| proposed | ${v1.rules.filter((r) => r.state === "proposed").length} |`,
    `| blocked | ${v1.rules.filter((r) => r.state === "blocked").length} |`,
    "",
    "## Regole congelate (usare così)",
    "",
  ];

  for (const r of v1.rules.filter((x) => x.state === "accepted")) {
    lines.push(`### ${r.ruleId}`);
    lines.push(`- **${r.giorgioPath}** → **${r.yapTarget}**`);
    lines.push(`- Confidence: ${r.confidence}`);
    if (r.decision) lines.push(`- ${r.decision}`);
    lines.push("");
  }

  lines.push("## Regole proposte (da validare operativamente)");
  for (const r of v1.rules.filter((x) => x.state === "proposed")) {
    lines.push(`- **${r.ruleId}**: ${r.decision || r.note || ""}`);
  }
  lines.push("");
  lines.push("## Bloccate (non usare finché non c'è evidenza)");
  for (const r of v1.rules.filter((x) => x.state === "blocked")) {
    lines.push(`- **${r.ruleId}**: ${r.decision}`);
  }
  lines.push("");
  lines.push("## Esempi Giorgio");
  lines.push("");
  lines.push("| ID | Caso | Stato |");
  lines.push("|----|------|-------|");
  for (const ex of v1.exampleStatus) {
    lines.push(`| ${ex.id} | ${ex.title} | ${ex.status} |`);
  }
  lines.push("");
  lines.push("## Comandi read-only");
  lines.push("");
  lines.push("```powershell");
  lines.push("node automation/yap/consolidate-evidence.mjs");
  lines.push("node automation/yap/build-mapping-preview.mjs --payload-file automation/yap/sample-payload.json");
  lines.push("node automation/yap/yap-readonly-day-scan.mjs --date YYYY-MM-DD");
  lines.push("```");
  lines.push("");
  lines.push("## Vietato");
  lines.push("- yap-worker --commit");
  lines.push("- doppio click slot vuoto");
  lines.push("- Nuovo appuntamento");
  return lines.join("\n");
}

async function main() {
  const evidence = await read("yap-evidence-dataset.json");
  const bridge = await read("yap-giorgio-bridge-mapping.json").catch(() => ({}));
  const apiIndex = evidence.apiIndex || {};

  const rules = buildRules(evidence, apiIndex);
  const exampleStatus = buildExampleStatus({}, apiIndex);

  const v1 = {
    schemaVersion: "1.0-frozen",
    frozenAt: new Date().toISOString(),
    mode: "readonly_study",
    evidenceSource: "analysis/yap-evidence-dataset.json",
    recordCount: evidence.recordCount,
    rules,
    exampleStatus,
    proposedYapDefaults: {
      cosa: "anagrafica.targa uppercase",
      quando: "agenda.data DD/MM/YYYY",
      dalle: "agenda.ora HH.MM",
      alle: "dalle + 20min",
      tags: {
        revisione: ["revisione"],
        carrozzeria: ["pneumatici", "preventivo?"],
        officina: ["officina"],
        misto: ["revisione"],
      },
    },
    openItems: [],
    supersededBy: bridge.schemaVersion ? "yap-giorgio-bridge-mapping.json (draft)" : null,
  };

  const v1Path = path.join(ANALYSIS, "yap-giorgio-bridge-mapping-v1.json");
  await fs.writeFile(v1Path, JSON.stringify(v1, null, 2), "utf8");

  const md = buildMarkdown(v1);
  await fs.writeFile(path.join(DIR, "READONLY_FINAL_REPORT.md"), md, "utf8");

  await fs.writeFile(
    path.join(ANALYSIS, "yap-giorgio-bridge-mapping.json"),
    JSON.stringify(
      {
        ...bridge,
        schemaVersion: "1.0",
        updatedAt: v1.frozenAt,
        frozenRulesRef: "yap-giorgio-bridge-mapping-v1.json",
        rulesV1Summary: {
          accepted: rules.filter((r) => r.state === "accepted").length,
          proposed: rules.filter((r) => r.state === "proposed").length,
          blocked: rules.filter((r) => r.state === "blocked").length,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`✅ Mapping v1: ${v1Path}`);
  console.log(`✅ Report: ${path.join(DIR, "READONLY_FINAL_REPORT.md")}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
