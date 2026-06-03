#!/usr/bin/env node
/**
 * Scraping read-only di N giorni agenda YAP via PrenotazioneTableAction.
 * Nessun click su eventi, nessuna scrittura.
 *
 * Uso:
 *   node yap-week-rpc-scan.mjs --from 2026-03-16 --days 7
 *   node yap-week-rpc-scan.mjs --from 2025-04-04 --days 7 --headed
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  buildYapTelemetry,
  createYapRuntime,
  loginYap,
  openAgendaWithRecovery,
  scanVisibleAgendaEvents,
  waitForAgendaEventPopulation,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

function parseArgs(argv) {
  const out = { days: 7, headed: false, freshLogin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from") out.from = argv[++i];
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--headed") out.headed = true;
    else if (a === "--fresh-login") out.freshLogin = true;
    else if (a === "--help" || a === "-h") {
      console.log("Uso: node yap-week-rpc-scan.mjs --from YYYY-MM-DD [--days 7] [--headed] [--fresh-login]");
      process.exit(0);
    }
  }
  if (!out.from || !/^\d{4}-\d{2}-\d{2}$/.test(out.from)) {
    console.error("Obbligatorio: --from YYYY-MM-DD");
    process.exit(1);
  }
  return out;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

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

function decodeDayFromTable(table, date) {
  const isoFromYap = (s) => {
    if (!/^\d{14}$/.test(s)) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}`;
  };
  const isPlate = (s) => /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(s);
  const isFlag = (s) => /^-?[COPR]+$/.test(s);
  const tagWords = [
    "revisione",
    "preventivo",
    "comunicato",
    "pneumatici",
    "officina",
    "carrozzeria",
    "tagliando",
    "perizia",
  ];

  const records = [];
  for (let i = 0; i < table.length; i += 1) {
    const iso = isoFromYap(table[i]);
    if (!iso || !iso.startsWith(date)) continue;

    const rec = { date, datetime: iso, plate: null, title: null, flags: [], tagHints: [] };
    const start = Math.max(0, i - 4);
    const end = Math.min(table.length, i + 16);
    for (let j = start; j < end; j += 1) {
      const v = String(table[j] || "");
      if (isPlate(v) && !rec.plate) rec.plate = v;
      if (/^[A-Z]{2}\d{3}[A-Z]{2} - /.test(v)) rec.title = v;
      if (isFlag(v)) rec.flags.push(v);
      const lower = v.toLowerCase();
      for (const tw of tagWords) {
        if (lower.includes(tw)) rec.tagHints.push(tw);
      }
    }
    rec.flags = [...new Set(rec.flags)];
    rec.tagHints = [...new Set(rec.tagHints)];
    if (rec.plate || rec.title) records.push(rec);
  }
  return records;
}

async function capturePrenotazioneForDate(page, date, credentials) {
  let captured = null;
  const handler = async (res) => {
    const url = res.url();
    if (!url.includes("/yap/action/PrenotazioneTableAction")) return;
    try {
      const text = await res.text();
      if (text && text.length > 5000) captured = text;
    } catch {}
  };
  page.on("response", handler);
  try {
    await openAgendaWithRecovery(page, {
      dateIso: date,
      username: credentials?.username || "",
      password: credentials?.password || "",
    });
    await page.waitForTimeout(2000);
  } finally {
    page.off("response", handler);
  }
  return captured;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  const dates = [];
  for (let i = 0; i < args.days; i += 1) dates.push(addDays(args.from, i));

  await fs.mkdir(ANALYSIS, { recursive: true });
  const startedAtMs = Date.now();
  const runtime = await createYapRuntime(chromium, {
    headed: args.headed,
    freshLogin: args.freshLogin,
    preferPersistentProfile: false,
    resolveModule: requireFromYap.resolve.bind(requireFromYap),
  });
  const { page } = runtime;
  const days = [];

  try {
    await loginYap(page, user, pass);
    await openAgendaWithRecovery(page, { username: user, password: pass });

    for (const date of dates) {
      console.log(`📅 ${date}…`);
      const raw = await capturePrenotazioneForDate(page, date, { username: user, password: pass });
      const viewport = await waitForAgendaEventPopulation(page);
      const domEvents = await scanVisibleAgendaEvents(page);
      let rpcRecords = [];
      if (raw) {
        const table = findStringTable(parseGwt(raw));
        rpcRecords = decodeDayFromTable(table, date);
      }
      days.push({
        date,
        viewport,
        domEventCount: domEvents.length,
        domEvents,
        rpcRecordCount: rpcRecords.length,
        rpcRecords,
        hasRpc: Boolean(raw),
        telemetry: buildYapTelemetry({
          runtime,
          viewport,
          eventCount: domEvents.length,
          startedAtMs,
          extra: { action: "readonly_week_scan", date },
        }),
      });
      console.log(`   DOM: ${domEvents.length}, RPC records: ${rpcRecords.length}`);
    }
  } finally {
    await runtime.close().catch(() => {});
  }

  const stats = buildStats(days);
  const out = {
    generatedAt: new Date().toISOString(),
    mode: "readonly_week_rpc_scan",
    range: { from: args.from, days: args.days, dates },
    days,
    stats,
    clientQuestionHints: inferClientAnswers(stats),
  };

  const outPath = path.join(ANALYSIS, "yap-week-dataset.json");
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n📊 ${outPath}`);
  console.log(`   Totale eventi DOM: ${stats.totalDomEvents}, record RPC: ${stats.totalRpcRecords}`);
  if (out.clientQuestionHints.length) {
    console.log("   Hint domande cliente:");
    for (const h of out.clientQuestionHints) console.log(`   - ${h}`);
  }
}

function buildStats(days) {
  const columnToTitles = {};
  const flagCounts = {};
  const titleHasRevisione = { with: 0, without: 0 };
  const preventivoComunicato = { both: 0, preventivoOnly: 0, neither: 0 };
  let totalDomEvents = 0;
  let totalRpcRecords = 0;

  for (const day of days) {
    totalDomEvents += day.domEventCount;
    totalRpcRecords += day.rpcRecordCount;
    for (const ev of day.domEvents) {
      const col = ev.repartoClass || "unknown";
      columnToTitles[col] = columnToTitles[col] || [];
      columnToTitles[col].push(ev.title.slice(0, 80));
      const t = ev.title.toLowerCase();
      if (t.includes("revisione")) titleHasRevisione.with += 1;
      else titleHasRevisione.without += 1;
      const hasPrev = t.includes("preventivo");
      const hasCom = t.includes("comunicato");
      if (hasPrev && hasCom) preventivoComunicato.both += 1;
      else if (hasPrev) preventivoComunicato.preventivoOnly += 1;
      else preventivoComunicato.neither += 1;
    }
    for (const rec of day.rpcRecords) {
      for (const f of rec.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
  }

  return {
    totalDomEvents,
    totalRpcRecords,
    columnCounts: Object.fromEntries(Object.entries(columnToTitles).map(([k, v]) => [k, v.length])),
    flagCounts,
    titleHasRevisione,
    preventivoComunicato,
  };
}

function inferClientAnswers(stats) {
  const hints = [];
  if (stats.totalDomEvents > 0) {
    hints.push(
      `Misto/revisione: ${stats.titleHasRevisione.with} eventi con 'revisione' nel titolo su ${stats.totalDomEvents} totali — da correlare con flag C/O/P/R.`,
    );
  }
  const pc = stats.preventivoComunicato;
  if (pc.both + pc.preventivoOnly > 0) {
    hints.push(
      `Preventivo/comunicato: ${pc.both} con entrambi nel titolo, ${pc.preventivoOnly} solo preventivo, ${pc.neither} né l'uno né l'altro.`,
    );
  }
  return hints;
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
