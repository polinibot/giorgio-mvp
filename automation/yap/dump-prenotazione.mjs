#!/usr/bin/env node
/**
 * Dump completo del PrenotazioneTableAction:
 * - separa string table (ultimo array di sole stringhe) da indici numerici
 * - per la targa cercata, prova a ricostruire la "tupla" record vicino al match
 */

import fs from "node:fs/promises";

const target = process.argv[2];
const search = (process.argv[3] || "DP126GZ").toUpperCase();
if (!target) {
  console.error("Uso: dump-prenotazione.mjs <trace.json> [SEARCH]");
  process.exit(2);
}

function parseGwt(text) {
  if (!text || !text.startsWith("//OK")) return null;
  return JSON.parse(text.slice(4));
}

const trace = JSON.parse(await fs.readFile(target, "utf8"));
const candidates = trace.traces.filter(
  (t) =>
    t.direction === "response" &&
    t.url.endsWith("PrenotazioneTableAction") &&
    t.length > 5000 &&
    t.decoded?.raw,
);
console.log(`PrenotazioneTableAction trovate: ${candidates.length}`);
for (const r of candidates) {
  const arr = parseGwt(r.decoded.raw);
  if (!Array.isArray(arr)) continue;
  let stringTable = null;
  let stringTableIdx = -1;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (Array.isArray(v) && v.length > 5 && v.every((x) => typeof x === "string")) {
      if (!stringTable || v.length > stringTable.length) {
        stringTable = v;
        stringTableIdx = i;
      }
    }
  }
  if (!stringTable) continue;
  console.log(`\n--- ${r.stage} | ${r.length}b | stringTable[${stringTable.length}] at idx ${stringTableIdx} ---`);
  const matches = stringTable
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.toUpperCase().includes(search));
  console.log("matches:", matches);
  for (const m of matches) {
    const start = Math.max(0, m.i - 20);
    const end = Math.min(stringTable.length, m.i + 50);
    console.log(`\n>> Vicinato di stringTable[${m.i}] = ${JSON.stringify(m.s)}:`);
    for (let i = start; i < end; i += 1) {
      console.log(`  [${i}] ${JSON.stringify(stringTable[i]).slice(0, 220)}`);
    }
  }
  if (r.stage === "goto-date") {
    console.log("\n--- StringTable completa (filtrata: solo testi leggibili) ---");
    const human = stringTable
      .map((s, i) => ({ s, i }))
      .filter((x) => /[a-zàèéìòù]/i.test(x.s) && x.s.length > 1);
    for (const x of human.slice(0, 80)) {
      console.log(`  [${x.i}] ${JSON.stringify(x.s).slice(0, 220)}`);
    }
    console.log(`  ... totale leggibili: ${human.length}`);
  }
}
