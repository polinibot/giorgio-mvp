#!/usr/bin/env node
/**
 * Shadow planner: piano completo agenda/pratica/ODL senza scrivere su YAP.
 *
 * Uso:
 *   node build-management-plan.mjs --payload-file automation/yap/sample-payload.json
 *   node build-management-plan.mjs --all-samples
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManagementPlan, normalizeMappingInput } from "./lib/yap-mapping.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

const SAMPLE_FILES = [
  "sample-payload.json",
  "sample-payload-carrozzeria-revisione.json",
  "sample-payload-revisione-pura.json",
];

function parseArgs(argv) {
  const args = { allSamples: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--payload-file") args.payloadFile = argv[++i];
    else if (argv[i] === "--all-samples") args.allSamples = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Uso: node build-management-plan.mjs --payload-file PATH | --all-samples");
      process.exit(0);
    }
  }
  if (!args.payloadFile && !args.allSamples) {
    console.error("Serve --payload-file o --all-samples");
    process.exit(1);
  }
  return args;
}

async function planFromFile(filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  const plan = buildManagementPlan(raw);
  plan.sourceFile = path.basename(filePath);
  plan.contexts = normalizeMappingInput(raw).contexts;
  return plan;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.allSamples
    ? SAMPLE_FILES.map((f) => path.join(DIR, f))
    : [path.resolve(args.payloadFile)];

  const plans = [];
  for (const f of files) {
    plans.push(await planFromFile(f));
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: "shadow_management_plan",
    planCount: plans.length,
    plans,
    summary: {
      giorgioAutomates: ["agenda popup: cosa, quando, dalle, alle, tag"],
      yapDelegates: ["gestione pratica", "ODL base", "righe revisione da tag"],
      phase2Optional: ["ore_man", "ore_mac", "materiali_euro", "ricambi in ODL"],
    },
  };

  const outPath = path.join(ANALYSIS, `management-plan-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");

  for (const p of plans) {
    console.log(`\n--- ${p.sourceFile} ---`);
    console.log(`  agenda: cosa=${p.agenda.cosa} tag=${p.agenda.tag.join(",")}`);
    console.log(`  pratica/ODL: ${p.gestione_pratica.action} / ${p.odl.action}`);
  }
  console.log(`\n📄 ${outPath}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
