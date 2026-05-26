#!/usr/bin/env node
/**
 * Decoder GWT-RPC mirato per PrenotazioneTableAction.
 *
 * Il GWT format è: //OK[<numeri/ref>, <stringTable>, <flags>...]
 * I "numeri" sono indici (1-based) nella stringTable (negativi se ref a oggetto).
 * Strategia pragmatica: ricostruiamo i record raggruppando per pattern
 * (datetime YYYYMMDDHHMMSS, label "Documento", customer, plate, VIN, code).
 */

import fs from "node:fs/promises";
import path from "node:path";

const target = process.argv[2];
const out = process.argv[3] || null;
if (!target) {
  console.error("Uso: decode-prenotazioni.mjs <trace.json> [out.json]");
  process.exit(2);
}

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

const prenotazioni = trace.traces.filter(
  (t) => t.direction === "response" && action(t.url) === "PrenotazioneTableAction" && t.length > 5000,
);

const used = new Set();
let table = null;
const dataResp = prenotazioni.find((r) => r.stage === "goto-date");
if (dataResp) {
  const arr = parseGwt(dataResp.decoded.raw);
  table = findStringTable(arr).table;
}
if (!table) {
  console.error("Nessuna stringTable trovata nelle PrenotazioneTableAction");
  process.exit(3);
}

const isoFromYap = (s) => {
  if (!/^\d{14}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
};

const isPlate = (s) => /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(s);
const isVin = (s) => /^[A-HJ-NPR-Z0-9]{17}$/.test(s);
const isPhone = (s) => /^\+?\d{8,15}$/.test(s);
const isCode = (s) => /^v\d{6,}/i.test(s) || /^\d{8,12}$/.test(s);
const isFlag = (s) => /^-?[COPR]+$/.test(s);

const dateIdxs = [];
for (let i = 0; i < table.length; i += 1) {
  if (isoFromYap(table[i])) dateIdxs.push(i);
}
console.log(`Trovate ${dateIdxs.length} date YAP`);

const records = [];
for (const dIdx of dateIdxs) {
  const window = {
    dateIdx: dIdx,
    dateIso: isoFromYap(table[dIdx]),
    fields: {},
  };

  const start = Math.max(0, dIdx - 4);
  const end = Math.min(table.length, dIdx + 14);
  for (let i = start; i < end; i += 1) {
    const v = table[i];
    if (i === dIdx) continue;
    if (!window.fields.label && v === "Documento") window.fields.label = v;
    else if (!window.fields.client && /^[A-ZÀ-Ù][A-ZÀ-Ù\s'`«»]{3,}$/.test(v) && !isPlate(v)) {
      const upper = v.toUpperCase();
      if (
        !upper.startsWith("KIT") &&
        !upper.startsWith("FIAT") &&
        !upper.startsWith("CITROEN") &&
        !upper.startsWith("MERCEDES") &&
        !upper.startsWith("RENAULT") &&
        !upper.startsWith("MAZDA") &&
        !upper.startsWith("PEUGEOT") &&
        !upper.startsWith("OPEL") &&
        !upper.startsWith("VOLKSWAGEN") &&
        !upper.startsWith("AUDI") &&
        !upper.startsWith("BMW") &&
        !upper.startsWith("HM ") &&
        !upper.startsWith("SEAT") &&
        !upper.startsWith("DACIA") &&
        !upper.startsWith("FORD")
      ) {
        window.fields.client = v;
      } else if (!window.fields.vehicle) {
        window.fields.vehicle = v;
      }
    } else if (!window.fields.vehicle && /^[A-ZÀ-Ù]/.test(v) && /[«»]/.test(v)) window.fields.vehicle = v;
    else if (!window.fields.title && /^[A-Z]{2}\d{3}[A-Z]{2} - /.test(v)) window.fields.title = v;
    else if (!window.fields.plate && isPlate(v)) window.fields.plate = v;
    else if (!window.fields.vin && isVin(v)) window.fields.vin = v;
    else if (!window.fields.code && isCode(v)) window.fields.code = v;
    else if (isPhone(v)) {
      window.fields.phones = window.fields.phones || [];
      window.fields.phones.push(v);
    } else if (isFlag(v)) {
      window.fields.flags = window.fields.flags || [];
      window.fields.flags.push(v);
    }
  }
  records.push(window);
}

console.log(`Record ricostruiti: ${records.length}`);

const knownPlates = ["DP126GZ", "EJ737EG", "EL733YJ", "FJ616CL", "GH572TV", "EY398AH", "ER898VV", "X9LH58", "FX339TM", "GA019BC", "GD109AR"];
console.log("\n=== Esempi rilevanti ===");
for (const r of records) {
  if (!r.fields.plate || !knownPlates.includes(r.fields.plate)) continue;
  console.log(JSON.stringify(r, null, 2));
}

console.log("\n=== Tutti i record (sintesi) ===");
for (const r of records) {
  console.log(
    `${r.dateIso || "?"} | ${r.fields.plate || "?".padEnd(7)} | ${r.fields.client || "?"}`.slice(0, 100),
    "tags:", r.fields.flags || [],
  );
}

if (out) {
  await fs.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), source: target, records }, null, 2));
  console.log(`\n📦 Scritto ${out}`);
}
