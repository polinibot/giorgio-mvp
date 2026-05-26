/**
 * Test YAP Delete Worker - Playwright con dati FAKE
 * 
 * ATTENZIONE: Solo test UI, nessun delete reale senza conferma umana
 * Dati: NOVEMBRE 2026, targhe TESTxxYY
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  plate: 'TEST99DD', // Targa fake per test
  date: '20/11/2026', // Futuro
  yapUrl: 'https://yap.mmbsoftware.it/?#!agenda',
  
  get credentials() {
    const envPath = join(__dirname, '..', '..', 'backend', '.env');
    if (!existsSync(envPath)) throw new Error('.env non trovato');
    
    const env = readFileSync(envPath, 'utf8');
    return {
      username: env.match(/YAP_USERNAME=(.+)/)?.[1],
      password: env.match(/YAP_PASSWORD=(.+)/)?.[1]
    };
  }
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export async function runDeleteWorkerTests() {
  console.log('\n🗑️  YAP DELETE WORKER TEST');
  console.log('==========================');
  console.log(`Targa test: ${CONFIG.plate} (FAKE)`);
  console.log(`Data test: ${CONFIG.date} (FUTURO)`);
  console.log('==========================\n');
  
  const results = { passed: 0, failed: 0, tests: [] };
  let browser;
  
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Test 1: Login
    console.log('⏳ [1/4] Login YAP...');
    try {
      const { username, password } = CONFIG.credentials;
      await page.goto(CONFIG.yapUrl, { waitUntil: 'networkidle' });
      await delay(2000);
      
      // Se c'è form login, compila
      const hasLogin = await page.locator('input[type="text"]').first().isVisible().catch(() => false);
      if (hasLogin) {
        await page.locator('input[type="text"]').first().fill(username);
        await page.locator('input[type="password"]').first().fill(password);
        await page.locator('button[type="submit"]').first().click();
        await delay(3000);
      }
      
      const loggedIn = page.url().includes('agenda');
      results.tests.push({ name: 'Login', passed: loggedIn });
      console.log(loggedIn ? '✅ Login OK' : '❌ Login FAIL');
    } catch (e) {
      results.tests.push({ name: 'Login', passed: false, error: e.message });
      console.log(`❌ Login ERROR: ${e.message}`);
    }
    
    // Test 2: Agenda caricata
    console.log('⏳ [2/4] Verifica Agenda...');
    try {
      await delay(2000);
      const hasAgenda = await page.locator('.gwt-TabLayoutPanel, .mgwt-TabBar').first().isVisible().catch(() => false);
      results.tests.push({ name: 'Agenda Loaded', passed: hasAgenda });
      console.log(hasAgenda ? '✅ Agenda OK' : '❌ Agenda FAIL');
    } catch (e) {
      results.tests.push({ name: 'Agenda Loaded', passed: false });
      console.log(`❌ Agenda ERROR: ${e.message}`);
    }
    
    // Test 3: Cerca targa fake (non deve trovare nulla)
    console.log('⏳ [3/4] Ricerca targa fake...');
    try {
      const pageContent = await page.content();
      const foundFakePlate = pageContent.includes(CONFIG.plate);
      results.tests.push({ name: 'Search Fake Plate', passed: !foundFakePlate }); // OK se NON trova
      console.log(!foundFakePlate ? '✅ Targa non trovata (OK)' : '⚠️  Targa trovata (vecchi dati?)');
    } catch (e) {
      results.tests.push({ name: 'Search Fake Plate', passed: false });
      console.log(`❌ Search ERROR: ${e.message}`);
    }
    
    // Test 4: Verifica elementi delete (UI only)
    console.log('⏳ [4/4] Verifica UI Delete...');
    try {
      // Cerca pulsanti o menu contestuale (senza cliccare)
      const deleteButtons = await page.locator('button:has-text("Elimina"), button:has-text("Cancella"), [title*="elimina"]').all();
      const hasDeleteUI = deleteButtons.length > 0;
      results.tests.push({ name: 'Delete UI Present', passed: hasDeleteUI });
      console.log(hasDeleteUI ? `✅ UI Delete OK (${deleteButtons.length} elementi)` : '⚠️  UI Delete non trovata');
    } catch (e) {
      results.tests.push({ name: 'Delete UI Present', passed: false });
      console.log(`❌ UI Delete ERROR: ${e.message}`);
    }
    
  } catch (e) {
    console.error(`\n❌ SUITE ERROR: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
  
  // Calcola risultati
  results.passed = results.tests.filter(t => t.passed).length;
  results.failed = results.tests.filter(t => !t.passed).length;
  
  console.log('\n==========================');
  console.log('📊 RISULTATI');
  console.log(`✅ Passati: ${results.passed}`);
  console.log(`❌ Falliti: ${results.failed}`);
  console.log('==========================\n');
  
  return results;
}

// Run diretto
if (import.meta.url === `file://${process.argv[1]}`) {
  runDeleteWorkerTests().then(r => process.exit(r.failed > 0 ? 1 : 0));
}
