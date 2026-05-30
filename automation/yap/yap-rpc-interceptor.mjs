#!/usr/bin/env node
/**
 * YAP RPC Interceptor - read-only.
 *
 * Bypassa il DOM popup: intercetta le POST /yap/action/* (GWT-RPC) prima/dopo
 * il click su un evento agenda e salva request+response complete.
 *
 * Niente scritture su YAP: si limita a navigare alla data, cliccare l'evento
 * e premere Esc dopo aver registrato la response.
 *
 * Uso:
 *   node yap-rpc-interceptor.mjs --date 2025-04-04 --search DP126GZ
 *   node yap-rpc-interceptor.mjs --date 2026-03-30 --search GD109AR --headed
 *
 * Output:
 *   automation/yap/analysis/rpc-trace-{date}-{slug}.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--search") out.search = argv[++i];
    else if (a === "--headed") out.headed = true;
    else if (a === "--label") out.label = argv[++i];
  }
  if (!out.date) throw new Error("--date YYYY-MM-DD obbligatorio");
  if (!out.search) throw new Error("--search TERM obbligatorio (targa, cliente, ecc.)");
  return out;
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isYapAction(url) {
  return /https?:\/\/[^/]*yap[^/]*\/yap\/action\//i.test(url);
}

function decodeGwtPreview(text) {
  if (typeof text !== "string") return null;
  if (!text.startsWith("//OK") && !text.startsWith("//EX")) return null;
  const status = text.startsWith("//OK") ? "ok" : "exception";
  const body = text.slice(4);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (!Array.isArray(parsed)) return { status, raw: text };
  const stringTable = parsed.find((x) => Array.isArray(x) && x.every((v) => typeof v === "string"));
  return {
    status,
    arrayShape: { length: parsed.length, types: parsed.map((v) => Array.isArray(v) ? "array" : typeof v) },
    stringTable: stringTable || [],
    raw: text,
  };
}

function extractActionName(payloadText) {
  const m = String(payloadText || "").match(/it\.indacosoftware\.[\w.]+(?:Action|Request)/g);
  if (!m) return null;
  return [...new Set(m)];
}

async function safeBody(req) {
  try {
    return req.postData();
  } catch {
    return null;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = process.env.YAP_USERNAME;
  const password = process.env.YAP_PASSWORD;
  if (!username || !password) {
    console.error("❌ Imposta YAP_USERNAME e YAP_PASSWORD");
    process.exit(2);
  }

  await fs.mkdir(ANALYSIS, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  const traces = [];
  const stages = { current: "boot" };

  page.on("request", (req) => {
    if (!isYapAction(req.url())) return;
    traces.push({
      ts: Date.now(),
      stage: stages.current,
      direction: "request",
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      body: req.postData() || null,
      actionGuess: extractActionName(req.postData()),
    });
  });

  page.on("response", async (res) => {
    if (!isYapAction(res.url())) return;
    const text = await safeText(res);
    traces.push({
      ts: Date.now(),
      stage: stages.current,
      direction: "response",
      status: res.status(),
      url: res.url(),
      length: text ? text.length : 0,
      contentType: res.headers()["content-type"] || "",
      decoded: decodeGwtPreview(text),
    });
  });

  try {
    stages.current = "login";
    await loginYap(page, username, password);

    stages.current = "open-agenda";
    await openAgendaInApp(page);

    stages.current = "goto-date";
    await gotoAgendaDate(page, args.date);
    await page.waitForTimeout(1500);

    stages.current = "click-event";
    const click = await clickAgendaEvent(page, [args.search]);
    if (!click?.success) {
      console.warn(`⚠️ Evento "${args.search}" non trovato il ${args.date} (proseguo con il salvataggio del traffico finora).`);
    } else {
      console.log(`✅ Click su: ${click.text} (colonna ${click.repartoClass || "n/d"})`);
    }

    stages.current = "wait-popup";
    await page.waitForTimeout(4500);

    stages.current = "close-popup";
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
  } catch (err) {
    console.error("⚠️ Errore durante la sessione:", err.message);
    traces.push({ ts: Date.now(), stage: stages.current, direction: "error", error: err.message });
  } finally {
    const fname = `rpc-trace-${args.date}-${slug(args.search)}${args.label ? "-" + slug(args.label) : ""}.json`;
    const outPath = path.join(ANALYSIS, fname);
    const summary = summarize(traces);
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          target: args,
          summary,
          traces,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`📦 Trace salvata: ${outPath}`);
    console.log(`   - request: ${summary.requestCount}, response: ${summary.responseCount}, actions distinct: ${summary.actions.length}`);
    if (summary.candidatePopupActions.length) {
      console.log("🎯 Possibili action popup-related:");
      for (const a of summary.candidatePopupActions) console.log(`   - ${a.action} (stage=${a.stage}, length=${a.length})`);
    }
    await browser.close().catch(() => {});
  }
}

function summarize(traces) {
  const requestCount = traces.filter((t) => t.direction === "request").length;
  const responseCount = traces.filter((t) => t.direction === "response").length;
  const actionsSet = new Set();
  for (const t of traces) {
    if (t.actionGuess) for (const a of t.actionGuess) actionsSet.add(a);
  }
  const candidatePopupActions = [];
  for (const t of traces) {
    if (t.direction === "response" && (t.stage === "click-event" || t.stage === "wait-popup")) {
      const tableLen = t.decoded?.stringTable?.length || 0;
      if (t.length > 800 || tableLen > 10) {
        candidatePopupActions.push({
          stage: t.stage,
          status: t.status,
          length: t.length,
          stringTableLen: tableLen,
          action: t.url.split("/").pop(),
        });
      }
    }
  }
  return {
    requestCount,
    responseCount,
    actions: [...actionsSet],
    candidatePopupActions,
  };
}

main().catch((e) => {
  console.error("❌", e.stack || e.message);
  process.exit(1);
});
