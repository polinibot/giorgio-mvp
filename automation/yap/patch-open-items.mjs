#!/usr/bin/env node
/** Aggiorna dataset + mapping v1 con ultime evidenze (scan 16/03, officina inferred). */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));
const ANALYSIS = path.join(DIR, "analysis");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DIR, cmd), ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function patchV1() {
  const v1Path = path.join(ANALYSIS, "yap-giorgio-bridge-mapping-v1.json");
  const v1 = JSON.parse(await fs.readFile(v1Path, "utf8"));

  const r006 = v1.rules.find((r) => r.ruleId === "R006_tag_officina");
  if (r006) {
    r006.state = "accepted";
    r006.confidence = "medium-high";
    r006.evidence.push("officina-kit-frizione-inferred.json");
    r006.popupInferred = {
      cosa: "DP126GZ",
      tagChips: ["officina"],
      quando: "04/04/2025",
      dalle: "10.20",
      alle: "10.40",
    };
    r006.decision =
      "Cosa=targa. Tag chip officina. Categoria O confermata via RPC su DP126GZ.";
    r006.nextCheck = "yap-agenda-inspector --date 2025-04-04 --search DP126GZ";
  }

  const r005 = v1.rules.find((r) => r.ruleId === "R005_tag_carrozzeria");
  if (r005) {
    r005.operationalRule =
      "Default pneumatici. Se lavorazioni includono revisione esplicita, usare solo chip revisione (eccezione Frigor).";
    r005.confidence = "medium-high";
  }

  v1.openItems = [];
  v1.resolvedOpenItems = [
    ...(v1.resolvedOpenItems || []),
    "Preventivo carrozzeria: comunicato resta manuale solo dopo invio al cliente",
  ].filter((item, index, arr) => arr.indexOf(item) === index);
  v1.frozenAt = new Date().toISOString();
  v1.patchNote = "Chiusi: scan 16/03 derivato, cofano blocked, Frigor regola operativa";

  const ex2 = v1.exampleStatus.find((e) => e.id === 2);
  if (ex2) {
    ex2.status = "inferred_from_historical";
    ex2.yapPopup = { cosa: "DP126GZ", tags: ["officina"] };
  }

  await fs.writeFile(v1Path, JSON.stringify(v1, null, 2), "utf8");

  const reportPath = path.join(DIR, "READONLY_FINAL_REPORT.md");
  let md = await fs.readFile(reportPath, "utf8");
  if (!md.includes("Ultime chiusure")) {
    md += `\n## Ultime chiusure (${new Date().toISOString().slice(0, 10)})\n\n`;
    md += `- Scan 2026-03-16: ricostruito da ispezione Italtrans (live scan in timeout)\n`;
    md += `- Officina Kit frizione: Cosa=DP126GZ, tag=officina (categoria O confermata via RPC)\n`;
    md += `- Cofano 15/03: resta blocked (non in agenda)\n`;
    md += `- Frigor: regola operativa carrozzeria + revisione se in lavorazioni\n`;
  }
  await fs.writeFile(reportPath, md, "utf8");
}

async function main() {
  await run("consolidate-evidence.mjs", []);
  await patchV1();
  console.log("✅ Patch open items completato");
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
