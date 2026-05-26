#!/usr/bin/env node
/**
 * YAP Agenda Inspector - Ispezione dettagliata appuntamenti trovati
 * 
 * Uso:
 *   node automation/yap/yap-agenda-inspector.mjs --date 2026-03-25 --search "Frigor"
 *   node automation/yap/yap-agenda-inspector.mjs --date 2026-03-23 --search "Passat"
 * 
 * Cosa fa:
 *   - Login su YAP
 *   - Naviga alla data specificata
 * *   - Cerca l'appuntamento per testo
 *   - Cattura screenshot prima/dopo apertura
 *   - Estrae testo completo dei campi visibili
 *   - Salva JSON con struttura rilevata
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loginYap, openAgendaInApp, gotoAgendaDate } from "./lib/yap-shared.mjs";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap-inspector");
const YAP_BASE_URL = process.env.YAP_BASE_URL || "https://yap.mmbsoftware.it";

function parseArgs(argv) {
  const args = {
    headed: false,
    artifactDir: process.env.YAP_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`Valore mancante per ${arg}`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--date") args.date = next();
    else if (arg === "--search") args.search = next();
    else if (arg === "--output-dir") args.outputDir = next();
    else if (arg === "--artifact-dir") args.artifactDir = next();
    else throw new Error(`Argomento non riconosciuto: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
YAP Agenda Inspector - Ispezione dettagliata appuntamenti

Uso:
  node automation/yap/yap-agenda-inspector.mjs --date 2026-03-25 --search "Frigor"
  node automation/yap/yap-agenda-inspector.mjs --date 2026-03-23 --search "Passat"

Parametri:
  --date YYYY-MM-DD    Data da ispezionare (obbligatorio)
  --search TEXT        Testo da cercare nell'appuntamento (obbligatorio)
  --headed             Mostra il browser (default: headless)
  --output-dir PATH    Directory per output JSON (default: artifactDir)

Variabili:
  YAP_USERNAME, YAP_PASSWORD
`);
}

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Variabile ambiente obbligatoria mancante: ${name}`);
  }
  return value.trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function clickIfVisible(locator, timeout = 1500) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function openAgendaDate(page, dateStr) {
  await openAgendaInApp(page);
  await gotoAgendaDate(page, dateStr);
  await page.locator(".fc-time-grid").first().waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(1000);
}

async function findAppointmentByText(page, searchText) {
  // Cerca in tutti gli elementi visibili
  const found = await page.evaluate((text) => {
    const lowerText = text.toLowerCase();
    const elements = [...document.querySelectorAll("*")].filter(el => {
      const content = (el.textContent || "").toLowerCase();
      return content.includes(lowerText) && el.children.length === 0;
    });
    
    return elements.map(el => ({
      text: el.textContent.trim(),
      tag: el.tagName,
      class: el.className,
      rect: el.getBoundingClientRect(),
    }));
  }, searchText);

  return found;
}

async function extractAllVisibleData(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const data = {
      inputs: [],
      textareas: [],
      selects: [],
      labels: [],
      buttons: [],
      popupText: [],
      rawText: [],
    };

    // Input visibili
    document.querySelectorAll("input").forEach(el => {
      if (!visible(el)) return;
      data.inputs.push({
        type: el.type,
        name: el.name,
        value: el.value,
        placeholder: el.placeholder,
        rect: el.getBoundingClientRect(),
      });
    });

    // Textarea
    document.querySelectorAll("textarea").forEach(el => {
      if (!visible(el)) return;
      data.textareas.push({
        name: el.name,
        value: el.value,
        placeholder: el.placeholder,
      });
    });

    // Select
    document.querySelectorAll("select").forEach(el => {
      if (!visible(el)) return;
      data.selects.push({
        name: el.name,
        value: el.value,
        options: [...el.options].map(o => o.text),
      });
    });

    // Label
    document.querySelectorAll("label").forEach(el => {
      if (!visible(el)) return;
      data.labels.push({
        text: el.textContent.trim(),
        for: el.htmlFor,
      });
    });

    // Bottoni
    document.querySelectorAll("button, .btn, [role='button']").forEach(el => {
      if (!visible(el)) return;
      data.buttons.push({
        text: el.textContent.trim(),
        class: el.className,
      });
    });

    // Popup/dialog text
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .popup, .dialog, [class*='popup'], [class*='dialog']")];
    popups.forEach(popup => {
      const text = popup.textContent.trim();
      if (text.length > 10 && text.length < 2000) {
        data.popupText.push(text);
      }
    });

    // Tutto il testo visibile raggruppato
    const allText = document.body.innerText || "";
    data.rawText = allText.split(/\n+/).map(t => t.trim()).filter(t => t.length > 2);

    return data;
  });
}

async function captureAppointmentDetails(page, searchText, artifactDir) {
  const timestamp = Date.now();
  const safeSearch = searchText.replace(/[^a-z0-9]/gi, "_").slice(0, 30);
  
  // Screenshot iniziale
  const initialPath = path.join(artifactDir, `initial-${safeSearch}-${timestamp}.png`);
  await page.screenshot({ path: initialPath, fullPage: true });

  // Trova e clicca appuntamento
  const found = await findAppointmentByText(page, searchText);
  if (found.length === 0) {
    return {
      found: false,
      searchText,
      initialScreenshot: initialPath,
      message: "Appuntamento non trovato per il testo specificato",
    };
  }

  // Clicca sul primo match
  const firstMatch = found[0];
  await page.mouse.click(firstMatch.rect.x + firstMatch.rect.width/2, firstMatch.rect.y + firstMatch.rect.height/2);
  await page.waitForTimeout(2000);

  // Screenshot dopo click
  const clickedPath = path.join(artifactDir, `clicked-${safeSearch}-${timestamp}.png`);
  await page.screenshot({ path: clickedPath, fullPage: true });

  // Aspetta popup se esiste
  let popupOpened = false;
  try {
    await page.getByText("Dettagli appuntamento", { exact: true }).first().waitFor({ state: "visible", timeout: 5000 });
    popupOpened = true;
  } catch {
    // Popup potrebbe avere titolo diverso
    popupOpened = await page.evaluate(() => {
      return !!document.querySelector(".gwt-DecoratedPopupPanel, .popup, [class*='appointment']");
    });
  }

  // Screenshot popup
  let popupPath = null;
  if (popupOpened) {
    await page.waitForTimeout(1000);
    popupPath = path.join(artifactDir, `popup-${safeSearch}-${timestamp}.png`);
    await page.screenshot({ path: popupPath, fullPage: true });
  }

  // Estrai tutti i dati visibili
  const extractedData = await extractAllVisibleData(page);

  return {
    found: true,
    searchText,
    initialScreenshot: initialPath,
    clickedScreenshot: clickedPath,
    popupScreenshot: popupPath,
    popupOpened,
    matchDetails: found[0],
    extractedData,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help || !args.date || !args.search) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  
  const artifactDir = await ensureDir(args.artifactDir);
  const outputDir = args.outputDir ? await ensureDir(args.outputDir) : artifactDir;

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    locale: "it-IT",
  });
  const page = await context.newPage();

  try {
    console.log(`🔍 Ispezione ${args.date} - cercando "${args.search}"...`);
    
    await loginYap(page, username, password);
    await openAgendaDate(page, args.date);
    
    const result = await captureAppointmentDetails(page, args.search, artifactDir);
    
    // Salva JSON risultato
    const outputFile = path.join(outputDir, `inspection-${args.date}-${args.search.replace(/[^a-z0-9]/gi, "_")}.json`);
    await fs.writeFile(outputFile, JSON.stringify(result, null, 2), "utf8");
    
    console.log("\n✅ Ispezione completata");
    console.log(`   Trovato: ${result.found}`);
    console.log(`   Screenshot: ${artifactDir}`);
    console.log(`   JSON: ${outputFile}`);
    
    if (result.found && result.extractedData) {
      console.log("\n📋 Campi rilevati:");
      console.log(`   Input: ${result.extractedData.inputs.length}`);
      console.log(`   Label: ${result.extractedData.labels.length}`);
      console.log(`   Bottoni: ${result.extractedData.buttons.length}`);
      console.log(`   Testo popup: ${result.extractedData.popupText.length} blocchi`);
    }

    return result;

  } finally {
    await context.close();
    await browser.close();
  }
}

main().then(result => {
  process.exit(result?.found ? 0 : 1);
}).catch(err => {
  console.error("❌ Errore:", err.message);
  process.exit(1);
});
