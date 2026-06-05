#!/usr/bin/env node
/**
 * Script di pulizia YAP novembre 2026
 * Elimina TUTTI gli appuntamenti di test di novembre 2026
 * Uso: node cleanup-yap-novembre.mjs --confirm
 */

import { chromium } from "playwright";
import fs from "node:fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const YAP_URL = "https://yap.mmbsoftware.it";
const USERNAME = process.env.YAP_USERNAME || "";
const PASSWORD = process.env.YAP_PASSWORD || "";

// Date di novembre 2026 da pulire
const DATES_TO_CLEAN = [
  "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10",
  "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
  "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
  "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25",
  "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"
];

const INVENTORY_PATH = path.join(__dirname, "analysis", "november-2026-inventory.json");

async function loadTargetsByDate() {
  try {
    const raw = await fs.readFile(INVENTORY_PATH, "utf8");
    const inventory = JSON.parse(raw);
    const targetsByDate = new Map();

    for (const day of inventory.days_with_events || []) {
      const searches = [];
      for (const event of day.events || []) {
        searches.push(event.title);
      }
      if (searches.length) targetsByDate.set(day.date, searches);
    }

    return { source: "inventory", targetsByDate };
  } catch {
    const fallback = new Map();
    for (const date of DATES_TO_CLEAN) {
      fallback.set(date, [
        "TEST AUTOMAZIONE",
        "ZZ555ZZ",
        "GIORGIO TEST",
        "TEST GIORGIO",
        "PROVA",
        "DEMO",
      ]);
    }
    return { source: "fallback_patterns", targetsByDate: fallback };
  }
}

async function login(page) {
  console.log("[LOGIN] Accesso YAP...");
  await page.goto(`${YAP_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const loginBtn = await page.locator("a:has-text('Login'), .gwt-Anchor:has-text('Login'), button:has-text('Login')").first();
  if (await loginBtn.isVisible().catch(() => false)) {
    await loginBtn.click();
    await page.waitForTimeout(1500);
  }
  
  const emailField = await page.locator("input[type='email'], input[name='email'], input[placeholder*='email' i]").first();
  const passwordField = await page.locator("input[type='password'], input[name='password'], input[placeholder*='password' i]").first();
  
  if (await emailField.isVisible().catch(() => false)) {
    if (!USERNAME || !PASSWORD) {
      throw new Error("Imposta YAP_USERNAME e YAP_PASSWORD per eseguire la pulizia YAP.");
    }
    await emailField.fill(USERNAME);
    await passwordField.fill(PASSWORD);
    
    const submitBtn = await page.locator("button[type='submit'], input[type='submit'], button:has-text('Accedi'), button:has-text('Login')").first();
    await submitBtn.click();
    
    await page.waitForTimeout(4000);
    console.log("[LOGIN] Completato");
  }
}

async function deleteAppointmentByDateAndSearch(page, date, search) {
  const formattedDate = date.split("-").reverse().join("/"); // 2026-11-16 -> 16/11/2026
  
  try {
    // Naviga all'agenda
    await page.goto(`${YAP_URL}/?agenda`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Clicca sulla data
    const dateCell = await page.locator(`td:has-text('${formattedDate}'), .fc-day:has-text('${parseInt(formattedDate)}')`).first();
    if (await dateCell.isVisible().catch(() => false)) {
      await dateCell.click();
      await page.waitForTimeout(1500);
    }
    
    // Cerca l'appuntamento
    const found = await page.locator(`text=${search}`).first().isVisible().catch(() => false);
    if (!found) {
      console.log(`  [SKIP] Nessun appuntamento trovato: ${date} + "${search}"`);
      return { deleted: false, reason: "not_found" };
    }
    
    // Clicca sull'appuntamento
    await page.locator(`text=${search}`).first().click();
    await page.waitForTimeout(1000);
    
    // Cerca bottone elimina
    const deleteBtn = await page.locator("button:has-text('Elimina'), a:has-text('Elimina'), .gwt-Button:has-text('Elimina')").first();
    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(1000);
      
      // Conferma eliminazione
      const confirmBtn = await page.locator("button:has-text('Sì'), button:has-text('Conferma'), .gwt-Button:has-text('OK')").first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
        console.log(`  [OK] Eliminato: ${date} + "${search}"`);
        return { deleted: true };
      }
    }
    
    // Se c'è ODL bloccante, prova ad aprire e scollegare
    const odlWarning = await page.locator("text=ODL, text=ordine di lavoro").first().isVisible().catch(() => false);
    if (odlWarning) {
      console.log(`  [ODL] Bloccato da ODL: ${date} + "${search}"`);
      // Tenta apertura pratica per gestione ODL
      return { deleted: false, reason: "blocked_by_odl" };
    }
    
    return { deleted: false, reason: "unknown" };
    
  } catch (err) {
    console.log(`  [ERR] ${date} + "${search}": ${err.message}`);
    return { deleted: false, reason: "error", error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const dryRun = !confirm;
  
  console.log("=".repeat(60));
  console.log("PULIZIA YAP NOVEMBRE 2026");
  console.log("=".repeat(60));
  console.log(`Modalità: ${dryRun ? "DRY-RUN (usa --confirm per eliminare davvero)" : "ELIMINAZIONE REALE"}`);
  console.log(`Date da pulire: ${DATES_TO_CLEAN.length}`);
  const { source, targetsByDate } = await loadTargetsByDate();
  const totalTargets = [...targetsByDate.values()].reduce((sum, items) => sum + items.length, 0);
  console.log("=".repeat(60));
  console.log(`Sorgente target: ${source}`);
  console.log(`Target totali: ${totalTargets}`);
  console.log("=".repeat(60));
  
  if (dryRun) {
    console.log("\n⚠️  DRY-RUN: Nessuna eliminazione effettuata");
    console.log("   Aggiungi --confirm per eliminare davvero\n");
  }
  
  const browser = await chromium.launch({ headless: !process.env.SHOW_BROWSER });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  
  try {
    await login(page);
    
    let totalDeleted = 0;
    let totalBlocked = 0;
    let totalNotFound = 0;
    let totalErrors = 0;
    
    for (const date of DATES_TO_CLEAN) {
      console.log(`\n[DATA] ${date}`);
      
      const searches = targetsByDate.get(date) || [];
      if (!searches.length) {
        console.log("  [SKIP] Nessun target per questa data");
        continue;
      }

      for (const search of searches) {
        if (dryRun) {
          console.log(`  [DRY-RUN] Cercherei ed eliminerei: ${date} + "${search}"`);
          totalDeleted++;
          continue;
        }
        
        const result = await deleteAppointmentByDateAndSearch(page, date, search);
        
        if (result.deleted) totalDeleted++;
        else if (result.reason === "blocked_by_odl") totalBlocked++;
        else if (result.reason === "not_found") totalNotFound++;
        else totalErrors++;
      }
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("RIEPILOGO");
    console.log("=".repeat(60));
    console.log(`Eliminati: ${totalDeleted}`);
    console.log(`Bloccati da ODL: ${totalBlocked}`);
    console.log(`Non trovati: ${totalNotFound}`);
    console.log(`Errori: ${totalErrors}`);
    console.log("=".repeat(60));
    
    if (totalBlocked > 0) {
      console.log("\n⚠️  ATTENZIONE: Alcuni appuntamenti sono bloccati da ODL.");
      console.log("   Usa lo script 'yap-delete-appointment.mjs' con gestione ODL automatica.");
    }
    
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
