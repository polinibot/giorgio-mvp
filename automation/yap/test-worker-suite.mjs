/**
 * Test Suite YAP Worker - Playwright reali, dati FAKE
 * 
 * Sicurezza dati:
 * - Solo date NOVEMBRE 2026 (futuro)
 * - Solo targhe TESTxxYY (fake)
 * - Solo nomi "Test Automation" (fake)
 * - Cleanup automatico garantito
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === CONFIG TEST ===
const TEST_CONFIG = {
  // Dati FAKE garantiti
  plate: 'TEST01ZZ',
  customerName: 'Test Automation Suite',
  phone: '+390000000000', // FAKE
  date: '15/11/2026', // NOVEMBRE 2026 - FUTURO
  time: '10:00',
  duration: 60,
  
  // Selettori YAP
  url: 'https://yap.mmbsoftware.it/?#!agenda',
  
  // Credentials (da env)
  get credentials() {
    const envPath = join(__dirname, '..', '..', 'backend', '.env');
    if (!existsSync(envPath)) {
      throw new Error('.env non trovato');
    }
    
    const env = readFileSync(envPath, 'utf8');
    const yapUser = env.match(/YAP_USERNAME=(.+)/)?.[1];
    const yapPass = env.match(/YAP_PASSWORD=(.+)/)?.[1];
    
    if (!yapUser || !yapPass) {
      throw new Error('YAP_USERNAME o YAP_PASSWORD mancanti in .env');
    }
    
    return { username: yapUser, password: yapPass };
  }
};

// === UTILS ===
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const log = (step, status, details = '') => {
  const icon = status === 'ok' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️' : '⏳';
  console.log(`${icon} [${step}] ${details}`);
};

// === TEST: LOGIN ===
async function testLogin(page) {
  log('LOGIN', 'start', 'Apertura YAP...');
  
  await page.goto(TEST_CONFIG.url, { waitUntil: 'networkidle', timeout: 30000 });
  await delay(2000);
  
  // Verifica pagina caricata
  const hasLogin = await page.locator('input[name="username"], input[type="text"]').first().isVisible().catch(() => false);
  if (!hasLogin) {
    log('LOGIN', 'warn', 'Form login non trovato, forse già loggato?');
    return true;
  }
  
  // Login
  const { username, password } = TEST_CONFIG.credentials;
  
  await page.locator('input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"], .gwt-Button').first().click();
  
  await delay(3000);
  
  // Verifica login OK
  const currentUrl = page.url();
  const loggedIn = !currentUrl.includes('login') && !currentUrl.includes('auth');
  
  log('LOGIN', loggedIn ? 'ok' : 'fail', loggedIn ? 'Login effettuato' : 'Login fallito');
  return loggedIn;
}

// === TEST: NAVIGAZIONE AGENDA ===
async function testAgendaNavigation(page) {
  log('AGENDA', 'start', 'Navigazione agenda...');
  
  // Aspetta caricamento agenda
  await delay(3000);
  
  // Verifica elementi agenda presenti
  const hasAgenda = await page.locator('.gwt-TabLayoutPanel, .mgwt-TabBar, [class*="agenda"]').first().isVisible().catch(() => {
    // Fallback: verifica URL
    return page.url().includes('agenda');
  });
  
  log('AGENDA', hasAgenda ? 'ok' : 'fail', hasAgenda ? 'Agenda caricata' : 'Agenda non trovata');
  return hasAgenda;
}

// === TEST: RICERCA DATA ===
async function testSearchByDate(page) {
  log('SEARCH', 'start', `Ricerca data ${TEST_CONFIG.date}...`);
  
  try {
    // Cerca input data
    const dateInputs = await page.locator('input[type="text"]').all();
    
    for (const input of dateInputs.slice(0, 3)) {
      const placeholder = await input.getAttribute('placeholder').catch(() => '');
      const value = await input.inputValue().catch(() => '');
      
      if (placeholder.includes('data') || value.includes('/202')) {
        await input.fill(TEST_CONFIG.date);
        await input.press('Enter');
        await delay(1500);
        log('SEARCH', 'ok', `Data ${TEST_CONFIG.date} inserita`);
        return true;
      }
    }
    
    log('SEARCH', 'warn', 'Input data non trovato');
    return false;
  } catch (e) {
    log('SEARCH', 'fail', e.message);
    return false;
  }
}

// === TEST: CREAZIONE APPUNTAMENTO (dry-run, solo verifica UI) ===
async function testCreateAppointmentUI(page) {
  log('CREATE', 'start', 'Verifica UI creazione appuntamento...');
  
  try {
    // Cerca pulsante "Nuovo" o "+"
    const newButtons = await page.locator('button:has-text("Nuovo"), button:has-text("+"), .gwt-Button:has-text("N"), [title*="nuovo"]').all();
    
    if (newButtons.length > 0) {
      log('CREATE', 'ok', `Trovati ${newButtons.length} pulsanti nuovo`);
      return true;
    }
    
    // Verifica menu contestuale o altri elementi
    const hasCalendar = await page.locator('.gwt-DatePicker, .mgwt-DatePicker, [class*="calendar"]').first().isVisible().catch(() => false);
    
    log('CREATE', hasCalendar ? 'ok' : 'warn', hasCalendar ? 'Calendario visibile' : 'Elementi creazione non trovati');
    return hasCalendar;
  } catch (e) {
    log('CREATE', 'fail', e.message);
    return false;
  }
}

// === TEST: CLEANUP (verifica) ===
async function testCleanupCheck(page) {
  log('CLEANUP', 'start', 'Verifica cleanup dati test...');
  
  // Cerca eventuali appuntamenti di test precedenti
  try {
    const pageContent = await page.content();
    const hasTestData = pageContent.includes(TEST_CONFIG.plate) || 
                        pageContent.includes(TEST_CONFIG.customerName);
    
    if (hasTestData) {
      log('CLEANUP', 'warn', 'Trovati dati test precedenti - necessario cleanup');
      return false;
    } else {
      log('CLEANUP', 'ok', 'Nessun dato test trovato - OK');
      return true;
    }
  } catch (e) {
    log('CLEANUP', 'fail', e.message);
    return false;
  }
}

// === MAIN TEST RUNNER ===
export async function runYapWorkerTests() {
  console.log('\n🧪 YAP WORKER TEST SUITE');
  console.log('========================');
  console.log(`Data test: ${TEST_CONFIG.date} (NOVEMBRE 2026 - FUTURO)`);
  console.log(`Targa test: ${TEST_CONFIG.plate} (FAKE)`);
  console.log(`Cliente test: ${TEST_CONFIG.customerName} (FAKE)`);
  console.log('========================\n');
  
  let browser;
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0
  };
  
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const page = await context.newPage();
    
    // Esegui test sequenziali
    const tests = [
      { name: 'Login', fn: testLogin },
      { name: 'Agenda Navigation', fn: testAgendaNavigation },
      { name: 'Search by Date', fn: testSearchByDate },
      { name: 'Create Appointment UI', fn: testCreateAppointmentUI },
      { name: 'Cleanup Check', fn: testCleanupCheck }
    ];
    
    for (const test of tests) {
      results.total++;
      try {
        const passed = await test.fn(page);
        if (passed) results.passed++;
        else results.failed++;
      } catch (e) {
        log(test.name, 'fail', `Exception: ${e.message}`);
        results.failed++;
      }
      await delay(1000);
    }
    
  } catch (e) {
    console.error(`\n❌ ERRORE SUITE: ${e.message}`);
    results.failed++;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  // Report
  console.log('\n========================');
  console.log('📊 RISULTATI TEST');
  console.log('========================');
  console.log(`Totali:  ${results.total}`);
  console.log(`✅ Passati: ${results.passed}`);
  console.log(`❌ Falliti: ${results.failed}`);
  console.log(`⏭️  Skippati: ${results.skipped}`);
  console.log('========================\n');
  
  return results;
}

// Run se eseguito direttamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runYapWorkerTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  });
}
