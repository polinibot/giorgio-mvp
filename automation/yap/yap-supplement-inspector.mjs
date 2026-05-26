#!/usr/bin/env node
/**
 * Ispezione supplementare: Cofano+revisione (15/03) e Kit frizione officina (20/03)
 * Usa termini alternativi (telefono, targa) quando il titolo non contiene la keyword.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  YAP_BASE_URL,
  ROOT_DIR,
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
} from "./lib/yap-shared.mjs";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(ROOT_DIR, "automation", "artifacts", "yap-supplement");
const ANALYSIS = path.join(__dirname, "analysis");

const SUPPLEMENT_TARGETS = [
  {
    id: 9,
    name: "Cofano_revisione",
    date: "2026-03-15",
    context: "revisione",
    terms: ["3285625559", "328562", "cofano", "freccia", "belotti"],
  },
  {
    id: 2,
    name: "Kit_frizione",
    date: "2026-03-20",
    context: "officina",
    terms: ["3351324672", "dp126gz", "bisio", "frizione", "pikhlyk"],
  },
];

async function extractPopup(page) {
  return page.evaluate(() => {
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")];
    const detailsPopup = popups.find((p) => {
      const text = p.textContent || "";
      return text.includes("Dettagli") || text.includes("appuntamento") || text.includes("Cosa");
    });
    if (!detailsPopup) return null;

    const inputs = [...detailsPopup.querySelectorAll("input")].map((i) => ({
      name: i.name || "",
      id: i.id || "",
      value: i.value || "",
      type: i.type || "text",
    }));

    const knownTags = [
      "pneumatici",
      "revisione",
      "officina",
      "carrozzeria",
      "comunicato",
      "preventivo",
      "tagliando",
      "meccanica",
    ];
    const tagChips = knownTags.filter((tag) => detailsPopup.textContent.toLowerCase().includes(tag));

    return {
      rawText: detailsPopup.innerText.split("\n").map((t) => t.trim()).filter(Boolean),
      inputs,
      tagChips,
    };
  });
}

async function inspectTarget(page, target, artifactsDir) {
  console.log(`\n📅 ${target.date} — ${target.name} (${target.context})`);
  await gotoAgendaDate(page, target.date);

  const beforeSS = path.join(artifactsDir, `${target.name}-before.png`);
  await page.screenshot({ path: beforeSS, fullPage: true });

  const clicked = await clickAgendaEvent(page, target.terms);
  if (!clicked.success) {
    console.log(`   ❌ Non trovato con termini: ${target.terms.join(", ")}`);
    return { found: false, termsTried: target.terms, screenshots: { before: beforeSS } };
  }

  console.log(`   👉 ${clicked.text.slice(0, 70)} [${clicked.repartoClass || ""}]`);
  await page.waitForTimeout(3000);

  const afterSS = path.join(artifactsDir, `${target.name}-after.png`);
  await page.screenshot({ path: afterSS, fullPage: true });
  const popup = await extractPopup(page);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);

  return {
    found: true,
    text: clicked.text,
    repartoClass: clicked.repartoClass,
    popup,
    screenshots: { before: beforeSS, after: afterSS },
  };
}

async function main() {
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("❌ Servono YAP_USERNAME e YAP_PASSWORD");
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

    for (const target of SUPPLEMENT_TARGETS) {
      try {
        const res = await inspectTarget(page, target, ARTIFACTS);
        results.push({ target, ...res });
      } catch (err) {
        results.push({ target, found: false, error: err.message });
      }
    }

    const report = { inspectedAt: new Date().toISOString(), results };
    const outPath = path.join(ANALYSIS, "supplement-inspection-results.json");
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\n📊 Report: ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
