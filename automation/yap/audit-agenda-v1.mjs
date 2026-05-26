#!/usr/bin/env node
/**
 * Audit agenda V2: mapping da contesti mini-app (fonte di verità).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickYapTags, pickCosa, normalizeMappingInput } from "./lib/yap-mapping.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

const CASES = [
  {
    id: "officina",
    file: "sample-payload.json",
    expectedTags: ["officina"],
    expectedCosa: "AB123CD - CONTROLLO VEICOLO",
  },
  {
    id: "revisione_pura",
    file: "sample-payload-revisione-pura.json",
    expectedTags: ["revisione"],
    expectedCosa: "REVISIONE",
    note: "EL733YJ: solo contesto revisione",
  },
  {
    id: "carrozzeria_solo",
    file: "sample-payload-carrozzeria-revisione.json",
    expectedTags: ["pneumatici", "preventivo"],
    expectedCosa: "GA019BC - VERNICIATURA CERCHI",
    note: "Solo contesto carrozzeria: tag da checkbox, non dal testo righe",
  },
  {
    id: "fd897lp_officina_revisione",
    file: "sample-payload-fd897lp-revisione.json",
    expectedTags: ["officina", "revisione"],
    expectedCosa: "FD897LP - RIPARARE FORATURA",
    note: "Contesti mini-app officina+revisione (evidenza YAP 2026-05-25)",
  },
];

async function main() {
  const results = [];

  for (const c of CASES) {
    const raw = JSON.parse(await fs.readFile(path.join(DIR, c.file), "utf8"));
    const mapping = normalizeMappingInput(raw);
    const tags = pickYapTags(mapping);
    const cosa = pickCosa(mapping);
    const tagsOk = JSON.stringify([...tags].sort()) === JSON.stringify([...c.expectedTags].sort());
    const cosaOk = cosa === c.expectedCosa;
    results.push({
      id: c.id,
      file: c.file,
      contexts: mapping.contexts,
      cosa,
      tags,
      expectedTags: c.expectedTags,
      expectedCosa: c.expectedCosa,
      pass: tagsOk && cosaOk,
      tagsOk,
      cosaOk,
      note: c.note || null,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "agenda_v2_audit",
    mappingEngine: "contexts_from_miniapp",
    cases: results,
    allCasesPass: results.every((r) => r.pass),
  };

  const outPath = path.join(ANALYSIS, "agenda-v1-audit.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== Agenda V2 Audit ===");
  for (const r of results) {
    console.log(`${r.pass ? "✅" : "❌"} ${r.id}: cosa=${r.cosa} tags=${r.tags.join(",")}`);
  }
  console.log(`\n📄 ${outPath}`);

  if (!report.allCasesPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
