#!/usr/bin/env node
/**
 * Estrae legenda colori/reparti dall'agenda YAP e classi CSS osservate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loginYap, openAgendaInApp, gotoAgendaDate, ROOT_DIR } from "./lib/yap-shared.mjs";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(__dirname, "analysis");
const ARTIFACTS = path.join(ROOT_DIR, "automation", "artifacts", "yap-legend");

async function collectEventClasses(page) {
  return page.evaluate(() => {
    const byClass = {};
    for (const el of document.querySelectorAll(".fc-time-grid-event, .fc-event")) {
      const classes = String(el.className || "").split(/\s+/);
      const repartoClass = classes.find((c) => /^LCWVQRD-b-[a-z]$/.test(c));
      if (!repartoClass) continue;
      const style = window.getComputedStyle(el);
      const entry = byClass[repartoClass] || {
        repartoClass,
        count: 0,
        bgColors: new Set(),
        borderColors: new Set(),
        sampleTitles: [],
      };
      entry.count += 1;
      if (style.backgroundColor) entry.bgColors.add(style.backgroundColor);
      if (style.borderColor) entry.borderColors.add(style.borderColor);
      const title = el.querySelector(".fc-title")?.textContent?.trim() || el.textContent?.trim() || "";
      if (title && entry.sampleTitles.length < 3) {
        entry.sampleTitles.push(title.slice(0, 80));
      }
      byClass[repartoClass] = entry;
    }
    return Object.values(byClass).map((item) => ({
      repartoClass: item.repartoClass,
      count: item.count,
      bgColors: [...item.bgColors],
      borderColors: [...item.borderColors],
      sampleTitles: item.sampleTitles,
    }));
  });
}

async function extractLegendPopup(page) {
  const candidates = [
    page.getByText("Legenda", { exact: false }),
    page.getByText("legenda", { exact: false }),
    page.locator('[title*="egenda" i]'),
  ];

  for (const locator of candidates) {
    try {
      if ((await locator.count()) === 0) continue;
      await locator.first().click({ timeout: 2000, force: true });
      await page.waitForTimeout(1200);
      const data = await page.evaluate(() => {
        const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, [class*=\"popup\"]")];
        for (const popup of popups) {
          const text = popup.innerText || "";
          if (/legenda/i.test(text)) {
            const lines = text
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 1);
            return { text, lines, html: popup.outerHTML.slice(0, 4000) };
          }
        }
        return null;
      });
      await page.keyboard.press("Escape").catch(() => {});
      if (data) return data;
    } catch {
      // try next locator
    }
  }
  return null;
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

  try {
    await loginYap(page, user, pass);
    await openAgendaInApp(page);
    await gotoAgendaDate(page, "2026-03-16");

    const legendPopup = await extractLegendPopup(page);
    const observedClasses = await collectEventClasses(page);

    await page.screenshot({ path: path.join(ARTIFACTS, "agenda-with-events.png"), fullPage: true });

    const report = {
      extractedAt: new Date().toISOString(),
      legendPopup,
      observedClasses,
      inferredMapping: {
        "LCWVQRD-b-f": {
          label: "Colonna gialla (osservata su Italtrans/carrozzeria-pneumatici)",
          confidence: "medium",
          sampleBg: "rgb(224, 194, 64)",
        },
        "LCWVQRD-b-r": {
          label: "Colonna azzurra (osservata su Passat/Frigor/revisione)",
          confidence: "medium",
          sampleBg: "azzurro",
        },
        "LCWVQRD-b-e": {
          label: "Colonna alternativa (Porta posteriore / pneumatici+preventivo)",
          confidence: "medium",
        },
        "LCWVQRD-b-n": {
          label: "Colonna marrone (altri eventi stesso giorno)",
          confidence: "low",
        },
        "LCWVQRD-b-a": {
          label: "Colonna grigia",
          confidence: "low",
        },
      },
      note: "La legenda testuale YAP puo non essere accessibile via automazione; usare observedClasses + deep-inspection per conferma.",
    };

    const outPath = path.join(ANALYSIS, "yap-legend-report.json");
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`✅ Legenda salvata: ${outPath}`);
    console.log(`   Classi osservate: ${observedClasses.map((c) => c.repartoClass).join(", ")}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
