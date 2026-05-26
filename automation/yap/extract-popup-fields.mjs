#!/usr/bin/env node
/**
 * Estrai i campi popup dalle response GWT raccolte:
 *  - PrenotazioneTableAction: lista prenotazioni + targa, cosa, cliente, telefono, data
 *  - PropertyGetAction: catalogo chip tag (meccanica leggera, pneumatici, ecc.)
 *  - Cerca occorrenze di parole tag note nel record DP126GZ vicino al match
 */

import fs from "node:fs/promises";

const target = process.argv[2];
const search = (process.argv[3] || "DP126GZ").toUpperCase();

function parseGwt(text) {
  if (!text || !text.startsWith("//OK")) return null;
  return JSON.parse(text.slice(4));
}

function findStringTable(arr) {
  let best = null;
  let bestIdx = -1;
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (Array.isArray(v) && v.length > 5 && v.every((x) => typeof x === "string")) {
      if (!best || v.length > best.length) {
        best = v;
        bestIdx = i;
      }
    }
  }
  return { table: best, idx: bestIdx };
}

const trace = JSON.parse(await fs.readFile(target, "utf8"));
const action = (url) => url.split("/").pop();

const property = trace.traces.filter(
  (t) => t.direction === "response" && action(t.url) === "PropertyGetAction" && t.length > 10000,
);

const allChips = new Set();
for (const r of property) {
  const arr = parseGwt(r.decoded.raw);
  if (!arr) continue;
  const { table } = findStringTable(arr);
  if (!table) continue;
  for (const s of table) {
    if (
      /^[a-zàèéìòù][a-zàèéìòù\s]{2,30}$/i.test(s) &&
      !s.includes("/") &&
      !s.startsWith("java") &&
      !s.startsWith("com.") &&
      !s.startsWith("it.")
    ) {
      const lower = s.toLowerCase().trim();
      if (
        /^(meccanica|tagliando|revisione|pneumatici|preventivo|comunicato|carrozzeria|officina|elettrauto|gomme|olio|freni|cambio|frizione|tagliand|elettric|diagnos|climati|ricarica|sostituz|verniciat)/.test(
          lower,
        )
      ) {
        allChips.add(lower);
      }
    }
  }
}
console.log("=== Catalogo chip da PropertyGetAction ===");
console.log([...allChips].sort());

const prenotazioni = trace.traces.filter(
  (t) => t.direction === "response" && action(t.url) === "PrenotazioneTableAction" && t.length > 5000,
);

for (const r of prenotazioni) {
  const arr = parseGwt(r.decoded.raw);
  if (!arr) continue;
  const { table } = findStringTable(arr);
  if (!table) continue;
  const idx = table.findIndex((s) => s.toUpperCase().includes(search));
  if (idx < 0) continue;

  console.log(`\n=== Record ${search} in ${action(r.url)} (${r.stage}) ===`);
  const start = Math.max(0, idx - 12);
  const end = Math.min(table.length, idx + 8);
  for (let i = start; i < end; i += 1) {
    console.log(`  [${i}] ${JSON.stringify(table[i]).slice(0, 220)}`);
  }

  const flagSet = ["C", "O", "P", "R", "CO", "CP", "CR", "OP", "OR", "PR", "COP", "COR", "CPR", "OPR", "COPR"];
  const flagsObserved = new Set();
  for (let i = Math.max(0, idx - 30); i < Math.min(table.length, idx + 30); i += 1) {
    if (flagSet.includes(table[i])) flagsObserved.add(table[i]);
  }
  console.log("  flag categorie nel vicinato:", [...flagsObserved]);

  const tagWords = [
    "meccanica leggera",
    "meccanica pesante",
    "pneumatici",
    "carrozzeria",
    "officina",
    "revisione",
    "preventivo",
    "comunicato",
    "tagliando",
    "frizione",
  ];
  const tagsHere = [];
  for (let i = Math.max(0, idx - 25); i < Math.min(table.length, idx + 25); i += 1) {
    const v = String(table[i] || "").toLowerCase();
    for (const w of tagWords) {
      if (v.includes(w)) tagsHere.push({ at: i, value: table[i] });
    }
  }
  if (tagsHere.length) {
    console.log("  tag-words nel vicinato:");
    for (const t of tagsHere) console.log(`    [${t.at}] ${JSON.stringify(t.value)}`);
  } else {
    console.log("  (nessun tag-word nel vicinato di 25 entries)");
  }

  console.log("  cellule >40 char nel vicinato (possibili note):");
  for (let i = Math.max(0, idx - 30); i < Math.min(table.length, idx + 30); i += 1) {
    const v = String(table[i] || "");
    if (v.length > 40 && /[\s]/.test(v) && !/^[A-Z0-9_]+$/.test(v)) {
      console.log(`    [${i}] ${JSON.stringify(v).slice(0, 280)}`);
    }
  }
}
