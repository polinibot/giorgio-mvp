#!/usr/bin/env node
/**
 * Scan read-only di un giorno agenda YAP.
 * Elenca tutti gli eventi .fc-event senza click (nessun popup, nessuna bozza).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loginYap,
  openAgendaWithRecovery,
  readAgendaViewportState,
  ROOT_DIR,
  scanVisibleAgendaEvents,
  yapContextOptions,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(__dirname, "analysis");

function parseArgs(argv) {
  const args = { headed: false, debug: false, freshLogin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") args.date = argv[++i];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--debug") args.debug = true;
    else if (arg === "--fresh-login") args.freshLogin = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Uso: node yap-readonly-day-scan.mjs --date YYYY-MM-DD [--headed] [--debug] [--fresh-login]");
      process.exit(0);
    }
  }
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error("Obbligatorio: --date YYYY-MM-DD");
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  await fs.mkdir(ANALYSIS, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();

  try {
    await loginYap(page, user, pass);
    await openAgendaWithRecovery(page, { dateIso: args.date, username: user, password: pass });

    const viewport = await readAgendaViewportState(page);
    const events = await scanVisibleAgendaEvents(page, { includeStyle: true });
    let screenshotPath = null;
    if (args.debug) {
      screenshotPath = path.join(
        ROOT_DIR,
        "automation",
        "artifacts",
        "yap-readonly",
        `day-${args.date}.png`,
      );
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    const report = {
      scannedAt: new Date().toISOString(),
      date: args.date,
      mode: "readonly",
      eventCount: events.length,
      viewport,
      events,
      screenshot: screenshotPath,
    };

    const outPath = path.join(ANALYSIS, `readonly-scan-${args.date}.json`);
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

    console.log(`✅ ${events.length} eventi su ${args.date}`);
    console.log(`   ${outPath}`);
    for (const ev of events.slice(0, 15)) {
      console.log(`   ${ev.time || "?"} [${ev.repartoClass}] ${ev.title.slice(0, 70)}`);
    }
    if (events.length > 15) console.log(`   ... +${events.length - 15} altri`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
