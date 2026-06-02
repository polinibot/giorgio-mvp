#!/usr/bin/env node
/**
 * Pulizia batch YAP novembre - una sola sessione, veloce!
 * Uso: node pulisci-batch-novembre.mjs [--dry-run]
 */

import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  yapContextOptions,
  launchChromiumWithFallback,
  ROOT_DIR,
} from "./lib/yap-shared.mjs";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DATES = [
  "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10",
  "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
  "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
  "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25",
  "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"
];

const SEARCHES = ["TEST AUTOMAZIONE", "ZZ555ZZ", "TEST GIORGIO"];

async function listVisibleEvents(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll(".fc-time-grid-event, .fc-event")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      })
      .map((el) => {
        const titleEl = el.querySelector(".fc-title") || el;
        const rect = el.getBoundingClientRect();
        return {
          title: (titleEl.textContent || "").replace(/\s+/g, " ").trim(),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      })
      .filter((ev) => ev.title);
  });
}

async function deleteEvent(page, event, dryRun) {
  if (dryRun) {
    console.log(`    [DRY-RUN] Eliminerei: "${event.title}"`);
    return { deleted: false, dryRun: true };
  }

  try {
    // Click sull'evento
    await page.mouse.click(event.x, event.y);
    await page.waitForTimeout(800);

    // Cerca "Elimina appuntamento"
    const elimina = await page.locator(".gwt-DecoratedPopupPanel a.gwt-Anchor").filter({ hasText: /Elimina/i }).first();
    if (await elimina.isVisible().catch(() => false)) {
      await elimina.click();
      await page.waitForTimeout(1200);

      // Conferma
      const conferma = await page.locator(".gwt-DialogBox button, .gwt-PopupPanel button").filter({ hasText: /Sì|Conferma|OK/i }).first();
      if (await conferma.isVisible().catch(() => false)) {
        await conferma.click();
        await page.waitForTimeout(2000);
        console.log(`    [OK] Eliminato: "${event.title}"`);
        return { deleted: true };
      }
    }

    // Chiudi popup se aperto
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    return { deleted: false, reason: "no_delete_button" };
  } catch (err) {
    await page.keyboard.press("Escape");
    return { deleted: false, reason: "error", error: err.message };
  }
}

async function handleDate(page, date, searches, dryRun, stats) {
  console.log(`\n[DATA] ${date}`);

  try {
    await gotoAgendaDate(page, date);
    await page.waitForTimeout(600);
  } catch (err) {
    console.log(`  [ERR] Navigazione data fallita: ${err.message}`);
    stats.errors++;
    return;
  }

  const events = await listVisibleEvents(page);
  console.log(`  Eventi visibili: ${events.length}`);

  for (const search of searches) {
    const matches = events.filter((ev) =>
      ev.title.toLowerCase().includes(search.toLowerCase())
    );

    if (matches.length === 0) {
      console.log(`  [SKIP] Nessun match per "${search}"`);
      continue;
    }

    console.log(`  [SEARCH] "${search}" -> ${matches.length} match`);

    for (const match of matches) {
      const result = await deleteEvent(page, match, dryRun);
      if (result.deleted) stats.deleted++;
      else if (result.dryRun) stats.wouldDelete++;
      else stats.failed++;

      // Breve pausa tra eliminazioni
      await page.waitForTimeout(500);
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("=".repeat(60));
  console.log("PULIZIA BATCH YAP NOVEMBRE 2026");
  console.log("=".repeat(60));
  console.log(`Modalità: ${dryRun ? "DRY-RUN (simulazione)" : "ELIMINAZIONE REALE"}`);
  console.log(`Date: ${DATES.length}`);
  console.log(`Ricerche: ${SEARCHES.join(", ")}`);
  console.log("=".repeat(60));

  if (!dryRun) {
    console.log("\n⚠️  ATTENZIONE: Verranno eliminati davvero gli appuntamenti!");
    console.log("   Ctrl+C per annullare, o premi invio per continuare...");
    // await new Promise(r => setTimeout(r, 3000)); // Auto-proceed after 3s
  }

  const browser = await launchChromiumWithFallback({ headless: true });
  const context = await browser.newContext(yapContextOptions());
  const page = await context.newPage();

  const stats = { deleted: 0, failed: 0, errors: 0, wouldDelete: 0 };

  try {
    console.log("\n[LOGIN] Accesso a YAP...");
    await loginYap(page);
    console.log("[LOGIN] OK!");

    console.log("[AGENDA] Apertura agenda...");
    await openAgendaInApp(page);
    await page.waitForTimeout(1000);
    console.log("[AGENDA] Pronta!\n");

    for (const date of DATES) {
      await handleDate(page, date, SEARCHES, dryRun, stats);
    }

  } finally {
    await context.close();
    await browser.close();
  }

  console.log("\n" + "=".repeat(60));
  console.log("RIEPILOGO");
  console.log("=".repeat(60));
  if (dryRun) {
    console.log(`Da eliminare: ${stats.wouldDelete}`);
  } else {
    console.log(`Eliminati: ${stats.deleted}`);
    console.log(`Falliti: ${stats.failed}`);
    console.log(`Errori navigazione: ${stats.errors}`);
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
