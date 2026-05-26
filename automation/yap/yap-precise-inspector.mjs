#!/usr/bin/env node
/**
 * YAP Precise Inspector - Ispezione mirata e ultra-robusta dei 5 match reali
 * 
 * Risolve i blocchi usando 'force: true' su Playwright e nascondendo i popup
 * bloccanti con iniezione CSS, andando dritto alle 5 date già verificate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACTS = path.join(ROOT, "automation", "artifacts", "yap-precise");
const ANALYSIS = path.join(ROOT, "automation", "yap", "analysis");
const YAP_URL = "https://yap.mmbsoftware.it";

// Match reali — terms[] = fallback se il primo termine non compare nel titolo agenda
const TARGETS = [
  { id: 8, name: "Italtrans", date: "2026-03-16", context: "carrozzeria", terms: ["Italtrans", "FX339TM", "italtrans"] },
  { id: 9, name: "Cofano_revisione", date: "2026-03-15", context: "revisione", terms: ["3285625559", "cofano", "freccia", "revisione"] },
  { id: 5, name: "Passat", date: "2026-03-23", context: "misto", terms: ["Passat", "RADWAN", "DK140TP"] },
  { id: 1, name: "Frigor_Trasporti", date: "2026-03-25", context: "carrozzeria", terms: ["Frigor", "GA019BC", "035953876"] },
  { id: 7, name: "Porta_posteriore", date: "2026-03-30", context: "carrozzeria", terms: ["3899885954", "GD109AR", "SINGH"] },
];

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); return d; }

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function gotoAgendaDate(page, isoDate) {
  const months = {
    gennaio: 0,
    febbraio: 1,
    marzo: 2,
    aprile: 3,
    maggio: 4,
    giugno: 5,
    luglio: 6,
    agosto: 7,
    settembre: 8,
    ottobre: 9,
    novembre: 10,
    dicembre: 11,
  };
  const target = new Date(`${isoDate}T12:00:00`);
  const targetIndex = target.getFullYear() * 12 + target.getMonth();
  const currentMonthIndex = async () => {
    const text = normalize(await page.locator(".view-switch").first().innerText({ timeout: 5000 }));
    const [monthName, yearText] = text.split(/\s+/);
    if (!(monthName in months) || !yearText) return null;
    return Number(yearText) * 12 + months[monthName];
  };

  for (let guard = 0; guard < 36; guard += 1) {
    const currentIndex = await currentMonthIndex();
    if (currentIndex == null || currentIndex === targetIndex) break;
    await page.locator(currentIndex > targetIndex ? ".prev-button" : ".next-button").first().click();
    await page.waitForTimeout(120);
  }

  const moved = await page.evaluate((targetDate) => {
    const target = new Date(`${targetDate}T12:00:00`);
    const titleButton = document.querySelector(".view-switch");
    if (!titleButton) return false;
    const day = String(target.getDate());
    const switchRoot = titleButton.parentElement?.parentElement?.parentElement || document.body;
    const candidates = [...switchRoot.querySelectorAll("button, div, span, td, a")]
      .filter((node) => (node.textContent || "").trim() === day)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const classes = String(node.className || "").toLowerCase();
        return rect.width > 0 && rect.height > 0 && !classes.includes("disabled") && !classes.includes("other");
      });
    const candidate = candidates[0];
    if (!candidate) return false;
    candidate.click();
    return true;
  }, isoDate).catch(() => false);

  if (!moved) await page.keyboard.press("Home").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
}

async function loginAndBypass(page, username, password) {
  console.log("🔐 Navigazione su YAP...");
  await page.goto(YAP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Clicca OK dell'informativa se presente (senza nasconderla con CSS per non bloccare lo stato GWT)
  const okBtn = page.getByRole("button", { name: /^OK$/i }).or(page.getByText("OK", { exact: true }));
  try {
    await okBtn.first().waitFor({ state: "visible", timeout: 5000 });
    await okBtn.first().click({ force: true });
    console.log("👉 Cliccato bottone OK dell'informativa");
  } catch (e) {
    console.log("⚠️ Bottone OK non cliccato tramite Playwright, provo fallback JS...");
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .gwt-Button, [role="button"]')];
      const ok = btns.find(b => b.textContent.trim().toUpperCase() === 'OK');
      if (ok) ok.click();
    });
  }

  await page.waitForTimeout(1000);

  console.log("✏️  Compilazione credenziali...");
  await page.locator('input[name="u"]').click({ force: true });
  await page.evaluate(() => { document.querySelector('input[name="u"]').value = ''; });
  await page.locator('input[name="u"]').pressSequentially(username, { delay: 50 });

  await page.locator('input[name="pw"]').click({ force: true });
  await page.evaluate(() => { document.querySelector('input[name="pw"]').value = ''; });
  await page.locator('input[name="pw"]').pressSequentially(password, { delay: 50 });

  console.log("🚀 Click pulsante login (bypassando overlay)...");
  await page.getByTestId("loginSubmitButton").or(page.getByRole("button", { name: /acc[ée]di/i })).first().click({ force: true });
  
  await page.waitForTimeout(5000);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  console.log("✅ Autenticato!");
}

async function inspectAppointment(page, target, artifactsDir) {
  console.log(`\n📅 Navigazione al ${target.date} per "${target.name}" via UI clicks...`);
  await gotoAgendaDate(page, target.date);


  // Rimuoviamo eventuali popup di caricamento o avvisi per vedere l'agenda pulita
  await page.evaluate(() => {
    // Rimuovi solo i popup di avviso/cookie, ma NON il popup dei dettagli dell'appuntamento (se lo apriamo dopo)
    document.querySelectorAll('.gwt-DecoratedPopupPanel').forEach(el => {
      if (!el.textContent.includes('Dettagli') && !el.textContent.includes('appuntamento')) {
        el.remove();
      }
    });
  }).catch(() => {});

  // Screenshot dell'agenda prima del click
  const beforeSS = path.join(artifactsDir, `agenda-${target.name}-before.png`);
  await page.screenshot({ path: beforeSS, fullPage: true });

  // Trova l'appuntamento contenente il termine
  const terms = target.terms || [target.term];
  console.log(`🔍 Ricerca elemento (${terms.join(" | ")})...`);

  // Clicca sull'appuntamento usando coordinate valutate via JS per precisione assoluta
  const clicked = await page.evaluate((searchTerms) => {
    const events = [...document.querySelectorAll('.fc-title, .fc-event, .fc-time-grid-event')];
    const normalizedTerms = searchTerms.map((t) => String(t || "").toLowerCase().trim()).filter(Boolean);
    const found = events.find(el => {
      const text = el.textContent.toLowerCase();
      return normalizedTerms.some((term) => text.includes(term));
    });
    if (found) {
      const rect = found.getBoundingClientRect();
      // Crea un evento click reale
      const evt = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      });
      found.dispatchEvent(evt);
      // Fai anche doppio click se serve
      const dblEvt = new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      });
      found.dispatchEvent(dblEvt);
      return { success: true, text: found.textContent.trim(), rect };
    }
    return { success: false };
  }, terms);

  if (!clicked.success) {
    console.log(`   ❌ Impossibile cliccare l'appuntamento. Termine non trovato nel testo della pagina.`);
    return { found: false };
  }

  console.log(`   👉 Cliccato: "${clicked.text.slice(0, 50)}..."`);
  await page.waitForTimeout(3000); // Attendi l'apertura del popup dettagli

  // Screenshot dopo il click (dovrebbe esserci il popup dettagli)
  const afterSS = path.join(artifactsDir, `agenda-${target.name}-after.png`);
  await page.screenshot({ path: afterSS, fullPage: true });

  // Estrai struttura del popup dettagli
  const popupDetails = await page.evaluate(() => {
    // Cerchiamo il pannello dei dettagli dell'appuntamento
    const popups = [...document.querySelectorAll('.gwt-DecoratedPopupPanel, [class*="popup"], [class*="dialog"]')];
    const detailsPopup = popups.find(p => p.textContent.includes('Dettagli') || p.textContent.includes('Appuntamento') || p.textContent.includes('Cosa'));
    
    if (!detailsPopup) return null;

    // Estrai tutti gli input dentro il popup
    const inputs = [...detailsPopup.querySelectorAll('input')].map(i => {
      // Trova la label associata o l'elemento di testo precedente
      let labelText = "";
      try {
        const parent = i.parentElement;
        const prev = i.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') labelText = prev.textContent.trim();
        else if (parent) labelText = parent.textContent.replace(i.value, "").trim().slice(0, 30);
      } catch {}

      return {
        name: i.name || "",
        id: i.id || "",
        value: i.value || "",
        placeholder: i.placeholder || "",
        type: i.type || "text",
        labelText
      };
    });

    // Estrai textarea
    const textareas = [...detailsPopup.querySelectorAll('textarea')].map(t => ({
      name: t.name || "",
      value: t.value || ""
    }));

    // Estrai select/tendine
    const selects = [...detailsPopup.querySelectorAll('select')].map(s => ({
      name: s.name || "",
      value: s.value || "",
      options: [...s.options].map(o => o.text)
    }));

    return {
      title: detailsPopup.querySelector('.caption, [class*="Title"], [class*="header"]')?.textContent?.trim() || "Dettagli Appuntamento",
      htmlSnippet: detailsPopup.outerHTML.slice(0, 2000),
      rawText: detailsPopup.innerText.split('\n').map(t => t.trim()).filter(t => t.length > 0),
      inputs,
      textareas,
      selects
    };
  });

  if (popupDetails) {
    console.log(`   ✅ Struttura popup estratta con successo!`);
    console.log(`      Campi rilevati: ${popupDetails.inputs.length} input, ${popupDetails.selects.length} select`);
  } else {
    console.log(`   ⚠️  Popup dettagli non rilevato nel DOM.`);
  }

  return {
    found: true,
    text: clicked.text,
    screenshots: { before: beforeSS, after: afterSS },
    popup: popupDetails
  };
}

async function main() {
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("❌ Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  await ensureDir(ARTIFACTS);
  await ensureDir(ANALYSIS);

  console.log("🚀 Avvio YAP Precise Inspector...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  const results = [];

  try {
    await loginAndBypass(page, user, pass);

    console.log("🚀 Navigazione iniziale all'agenda...");
    await page.goto(`${YAP_URL}/#!agenda`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.locator(".fc-time-grid, .fc-view-container, body").first().waitFor({ state: "visible", timeout: 45000 });

    for (const target of TARGETS) {
      try {
        const res = await inspectAppointment(page, target, ARTIFACTS);
        results.push({ target, ...res });
      } catch (err) {
        console.error(`❌ Errore durante l'ispezione di ${target.name}:`, err.message);
        results.push({ target, error: err.message });
      }
    }

    // Report strutturato finale
    const report = {
      inspectedAt: new Date().toISOString(),
      results
    };

    await fs.writeFile(
      path.join(ANALYSIS, "precise-inspection-results.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );

    console.log("\n📊 Ispezione completata.");
    console.log(`   Report JSON salvato in: ${path.join(ANALYSIS, "precise-inspection-results.json")}`);
    console.log(`   Screenshot salvati in: ${ARTIFACTS}`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("❌ Errore irreversibile:", err);
  process.exit(1);
});
