#!/usr/bin/env node
/**
 * Consolida dataset settimana da scan read-only esistenti + decode RPC trace.
 * Offline, nessun browser.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

function parseGwt(text) {
  if (!text || !text.startsWith("//OK")) return null;
  try {
    return JSON.parse(text.slice(4));
  } catch {
    return null;
  }
}

function findStringTable(arr) {
  let best = [];
  if (!Array.isArray(arr)) return best;
  for (const v of arr) {
    if (Array.isArray(v) && v.length > best.length && v.every((x) => typeof x === "string")) {
      best = v;
    }
  }
  return best;
}

function decodeRecordsFromTable(table, dateFilter) {
  const isoFromYap = (s) => {
    if (!/^\d{14}$/.test(s)) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}`;
  };
  const isPlate = (s) => /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(s);
  const isFlag = (s) => /^-?[COPR]+$/.test(s);

  const records = [];
  for (let i = 0; i < table.length; i += 1) {
    const iso = isoFromYap(table[i]);
    if (!iso) continue;
    const date = iso.slice(0, 10);
    if (dateFilter && date !== dateFilter) continue;

    const rec = { date, datetime: iso, plate: null, title: null, flags: [] };
    for (let j = Math.max(0, i - 4); j < Math.min(table.length, i + 16); j += 1) {
      const v = String(table[j] || "");
      if (isPlate(v) && !rec.plate) rec.plate = v;
      if (/^[A-Z]{2}\d{3}[A-Z]{2} - /.test(v)) rec.title = v;
      if (isFlag(v)) rec.flags.push(v);
    }
    rec.flags = [...new Set(rec.flags)];
    if (rec.plate || rec.title) records.push(rec);
  }
  return records;
}

async function loadReadonlyScans() {
  const files = (await fs.readdir(ANALYSIS)).filter((f) => f.startsWith("readonly-scan-") && f.endsWith(".json"));
  const days = [];
  for (const f of files.sort()) {
    const data = JSON.parse(await fs.readFile(path.join(ANALYSIS, f), "utf8"));
    days.push({
      date: data.date,
      source: f,
      domEventCount: data.eventCount || data.events?.length || 0,
      domEvents: data.events || [],
    });
  }
  return days;
}

async function loadRpcDays() {
  const files = (await fs.readdir(ANALYSIS)).filter((f) => f.startsWith("rpc-trace-") && f.endsWith(".json"));
  const byDate = new Map();

  for (const f of files) {
    const trace = JSON.parse(await fs.readFile(path.join(ANALYSIS, f), "utf8"));
    const date = trace.target?.date;
    if (!date) continue;
    const action = (url) => String(url || "").split("/").pop();
    const prenotazioni = trace.traces?.filter(
      (t) => t.direction === "response" && action(t.url) === "PrenotazioneTableAction" && t.length > 5000,
    );
    for (const r of prenotazioni || []) {
      const table = r.decoded?.stringTable || findStringTable(parseGwt(r.decoded?.raw));
      const records = decodeRecordsFromTable(table, date);
      if (!byDate.has(date)) byDate.set(date, { date, rpcRecords: [], sources: [] });
      const entry = byDate.get(date);
      entry.rpcRecords.push(...records);
      entry.sources.push(f);
    }
  }
  return [...byDate.values()];
}

function buildStats(allDays) {
  const columnCounts = {};
  const flagCounts = {};
  const titlePatterns = { revisione: 0, preventivo: 0, comunicato: 0, total: 0 };
  let totalDom = 0;
  let totalRpc = 0;

  for (const day of allDays) {
    totalDom += day.domEventCount || 0;
    totalRpc += day.rpcRecordCount || 0;
    for (const ev of day.domEvents || []) {
      const col = ev.repartoClass || "unknown";
      columnCounts[col] = (columnCounts[col] || 0) + 1;
      const t = String(ev.title || "").toLowerCase();
      if (t && !t.includes("non ce")) {
        titlePatterns.total += 1;
        if (t.includes("revisione")) titlePatterns.revisione += 1;
        if (t.includes("preventivo")) titlePatterns.preventivo += 1;
        if (t.includes("comunicato")) titlePatterns.comunicato += 1;
      }
    }
    for (const rec of day.rpcRecords || []) {
      for (const f of rec.flags || []) flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
  }

  return { totalDom, totalRpc, columnCounts, flagCounts, titlePatterns };
}

function inferClientAnswers(stats) {
  const answers = [];
  const tp = stats.titlePatterns;
  if (tp.revisione > 0) {
    answers.push({
      question: "Pratiche miste = un solo appuntamento?",
      inference: "Nei titoli agenda, revisione compare come suffisso nel titolo (es. MORELLI - REVISIONE), non come appuntamento separato.",
      confidence: "medium-high",
      needsClientConfirm: false,
    });
  }
  if (tp.preventivo === 0 && tp.comunicato === 0) {
    answers.push({
      question: "Preventivo/comunicato nei titoli agenda?",
      inference: "Nei dataset DOM analizzati non compaiono 'preventivo'/'comunicato' nei titoli barra: sono tag chip popup, non testo barra. Decisione cliente: comunicato resta manuale dopo invio preventivo.",
      confidence: "medium",
      needsClientConfirm: false,
    });
  }
  return answers;
}

async function main() {
  const scanDays = await loadReadonlyScans();
  const rpcDays = await loadRpcDays();
  const dateMap = new Map();

  for (const d of scanDays) {
    dateMap.set(d.date, { date: d.date, domEvents: d.domEvents, domEventCount: d.domEventCount, sources: [d.source] });
  }
  for (const r of rpcDays) {
    const prev = dateMap.get(r.date) || { date: r.date, domEvents: [], domEventCount: 0, sources: [] };
    prev.rpcRecords = r.rpcRecords;
    prev.rpcRecordCount = r.rpcRecords.length;
    prev.sources = [...new Set([...(prev.sources || []), ...r.sources])];
    dateMap.set(r.date, prev);
  }

  const days = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const stats = buildStats(days);
  const clientQuestionHints = inferClientAnswers(stats);

  const out = {
    generatedAt: new Date().toISOString(),
    mode: "consolidated_offline_week_dataset",
    dayCount: days.length,
    days,
    stats,
    clientQuestionHints,
    columnMappingProposed: {
      "LCWVQRD-b-e": "O (Officina) — es. DP126GZ",
      "LCWVQRD-b-r": "R (Revisione) — colore azzurro, titoli con REVISIONE",
      "LCWVQRD-b-f": "C/P (Carrozzeria/Pneumatici) — colore giallo",
      "LCWVQRD-b-a": "altro/neutro — da campionare",
    },
  };

  const outPath = path.join(ANALYSIS, "yap-week-dataset.json");
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");

  console.log(`Giorni: ${days.length}, DOM events: ${stats.totalDom}, RPC records: ${stats.totalRpc}`);
  console.log("Colonne:", JSON.stringify(stats.columnCounts));
  console.log("Flag RPC:", JSON.stringify(stats.flagCounts));
  console.log(`\n📄 ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
