#!/usr/bin/env node
/**
 * Dry-run mapping (senza browser): anteprima Giorgio → YAP per tutti i sample.
 * Confronta popup proposto con regole v2 (audit + buildManagementPlan).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMappingInput,
  pickCosa,
  pickYapTags,
  pickWorkBrief,
  buildYapPreview,
  isRevisionePura,
} from "./lib/yap-mapping.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

const SAMPLES = [
  { id: "officina", file: "sample-payload.json" },
  { id: "revisione_pura", file: "sample-payload-revisione-pura.json" },
  { id: "carrozzeria", file: "sample-payload-carrozzeria-revisione.json" },
  { id: "fd897lp", file: "sample-payload-fd897lp-revisione.json" },
];

function toItalianDate(iso) {
  const [y, m, d] = String(iso || "").slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function toYapTime(time) {
  return String(time || "").trim().replace(":", ".");
}

function addMinutes(time, minutes) {
  const [h, m] = String(time || "00:00").split(":").map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m + minutes, 0));
  return `${String(d.getUTCHours()).padStart(2, "0")}.${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function main() {
  const cases = [];

  for (const sample of SAMPLES) {
    const raw = JSON.parse(await fs.readFile(path.join(DIR, sample.file), "utf8"));
    const mapping = normalizeMappingInput(raw);
    const preview = buildYapPreview(mapping);
    const popup = preview.proposedYap.popup;
    const ora = mapping.agenda.ora || mapping.agenda.time;
    const durata = Number(mapping.agenda.durata_minuti || 20);

    const workerPlanned = {
      cosa: pickCosa(mapping),
      quando: toItalianDate(mapping.agenda.data),
      dalle: toYapTime(ora),
      alle: addMinutes(ora, durata),
      tags: pickYapTags(mapping),
    };

    const match =
      workerPlanned.cosa === popup.cosa &&
      workerPlanned.quando === popup.quando &&
      workerPlanned.dalle === popup.dalle &&
      workerPlanned.alle === popup.alle &&
      JSON.stringify([...workerPlanned.tags].sort()) === JSON.stringify([...(popup.tag || [])].sort());

    cases.push({
      id: sample.id,
      file: sample.file,
      contexts: mapping.contexts,
      revisionePura: isRevisionePura(mapping),
      cosa_breve: pickWorkBrief(mapping) || null,
      planned: workerPlanned,
      previewPopup: {
        cosa: popup.cosa,
        quando: popup.quando,
        dalle: popup.dalle,
        alle: popup.alle,
        tag: popup.tag,
      },
      confidence: preview.confidence,
      odlReparti: (preview.proposedYap.odl?.lavorazioniGiorgio || []).map((l) => l.reparto),
      pass: match,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "mapping_dry_batch_no_browser",
    clientRules: {
      tags: "tutti i contesti spuntati in mini-app",
      cosa: "best-effort; YAP compone barra agenda",
      noTextInference: true,
    },
    allPass: cases.every((c) => c.pass),
    cases,
  };

  const outPath = path.join(ANALYSIS, "mapping-dry-batch-report.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== Mapping dry batch (no YAP write) ===\n");
  for (const c of cases) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.id}`);
    console.log(`   contesti: ${c.contexts.join(", ")}`);
    console.log(`   Cosa: ${c.planned.cosa}  [${c.confidence.cosa}]`);
    console.log(`   tag: ${c.planned.tags.join(", ")}`);
    console.log(`   ODL reparti: ${c.odlReparti.join(", ")}\n`);
  }
  console.log(`📄 ${outPath}`);

  if (!report.allPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
