#!/usr/bin/env node
/**
 * Batch read-only: scan date + optional popup inspect su termini noti.
 * Nessuna scrittura YAP.
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
  ROOT_DIR,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const ANALYSIS = path.join(path.dirname(fileURLToPath(import.meta.url)), "analysis");
const ARTIFACTS = path.join(ROOT_DIR, "automation", "artifacts", "yap-readonly");

const JOBS = [
  { date: "2025-04-04", terms: ["DP126GZ", "KIT FRIZIONE"], inspectPopup: true, giorgioId: 2, context: "officina" },
  { date: "2026-03-14", terms: ["3285625559", "cofano", "revisione", "belotti"], inspectPopup: true, giorgioId: 9, context: "revisione" },
  { date: "2026-03-15", terms: ["3285625559", "cofano", "revisione", "belotti", "freccia"], inspectPopup: false, giorgioId: 9, context: "revisione" },
  { date: "2026-03-16", terms: ["FX339TM", "Italtrans"], inspectPopup: true, giorgioId: 8, context: "carrozzeria" },
  { date: "2026-03-21", terms: ["3351324672", "dp126gz", "frizione", "bisio"], inspectPopup: false, giorgioId: 2, context: "officina" },
];

async function scanDay(page) {
  return page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(".fc-time-grid-event, .fc-event")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2) continue;
      const title = (el.querySelector(".fc-title") || el).textContent.replace(/\s+/g, " ").trim();
      const time = (el.querySelector(".fc-time")?.textContent || "").trim();
      const key = `${time}|${title}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const repartoClass = String(el.className || "").split(/\s+/).find((c) => /^LCWVQRD-b-[a-z]$/.test(c)) || "";
      rows.push({ time, title, repartoClass });
    }
    return rows.sort((a, b) => a.time.localeCompare(b.time));
  });
}

async function extractPopup(page) {
  return page.evaluate(() => {
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")].find((p) =>
      (p.textContent || "").includes("Dettagli"),
    );
    if (!popup) return null;
    const inputs = [...popup.querySelectorAll("input")].map((i) => ({
      value: i.value || "",
      type: i.type,
    }));
    const knownTags = ["pneumatici", "revisione", "comunicato", "preventivo", "tagliando", "meccanica", "officina", "carrozzeria"];
    const tagChips = knownTags.filter((t) => popup.textContent.toLowerCase().includes(t));
    const cosa = inputs.find((i) => i.value && !/^\d{2}\/\d{2}\/\d{4}$/.test(i.value) && !/^\d{1,2}\.\d{2}$/.test(i.value))?.value;
    const quando = inputs.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.value))?.value;
    const times = inputs.filter((i) => /^\d{1,2}\.\d{2}$/.test(i.value)).map((i) => i.value);
    return { cosa, quando, dalle: times[0], alle: times[1], tagChips, inputCount: inputs.length };
  });
}

async function runJob(page, job, artifactsDir) {
  console.log(`\n📅 ${job.date} [${job.context}]`);
  await gotoAgendaDate(page, job.date);
  const events = await scanDay(page);
  const matches = events.filter((ev) =>
    job.terms.some((t) => ev.title.toLowerCase().includes(String(t).toLowerCase())),
  );

  const result = {
    job,
    eventCount: events.length,
    matches,
    popup: null,
    clicked: null,
  };

  await page.screenshot({
    path: path.join(artifactsDir, `batch-${job.date}-agenda.png`),
    fullPage: true,
  });

  if (job.inspectPopup && matches.length) {
    const clicked = await clickAgendaEvent(page, job.terms);
    if (clicked.success) {
      await page.waitForTimeout(2500);
      result.clicked = clicked;
      result.popup = await extractPopup(page);
      await page.screenshot({
        path: path.join(artifactsDir, `batch-${job.date}-popup.png`),
        fullPage: true,
      });
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  console.log(`   eventi: ${events.length}, match: ${matches.length}, popup: ${result.popup ? "sì" : "no"}`);
  return result;
}

async function main() {
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.mkdir(ANALYSIS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const results = [];

  try {
    await loginYap(page, user, pass);
    await openAgendaInApp(page);

    for (const job of JOBS) {
      try {
        results.push(await runJob(page, job, ARTIFACTS));
      } catch (err) {
        results.push({ job, error: err.message });
      }
      await page.waitForTimeout(800);
    }

    const outPath = path.join(ANALYSIS, "readonly-batch-results.json");
    await fs.writeFile(outPath, JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2), "utf8");
    console.log(`\n📊 ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
