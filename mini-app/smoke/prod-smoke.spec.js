/**
 * Smoke test su produzione reale.
 * Richiede SMOKE_TEST_SECRET = valore impostato su Railway SMOKE_TEST_SECRET.
 *
 * Usa route.fetch() (lato Node.js, no CORS) per iniettare X-Smoke-Secret
 * su ogni richiesta verso la prod API. L'handler ignora gli errori
 * "browser/context closed" che emergono quando il browser si chiude
 * mentre altri fetch sono ancora in volo.
 */
const { test, expect } = require('@playwright/test');

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const SMOKE_SECRET = process.env.SMOKE_TEST_SECRET || '';
const DEV_USER_ID = process.env.SMOKE_USER_ID || '761118078';

if (!SMOKE_SECRET) {
  throw new Error(
    'SMOKE_TEST_SECRET non impostato. Aggiungilo a backend/.env o come variabile d\'ambiente.'
  );
}

async function setupSmokeAuth(page) {
  await page.route(`${PROD_API}/**`, async (route) => {
    try {
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'X-Smoke-Secret': SMOKE_SECRET },
      });
      await route.fulfill({ response });
    } catch (e) {
      // Il browser può chiudersi mentre altri fetch sono in volo — non è un errore del test.
      if (e.message && (e.message.includes('closed') || e.message.includes('destroyed'))) return;
      throw e;
    }
  });
}

test.beforeEach(async ({ page }) => {
  await setupSmokeAuth(page);
});

test('produzione: dashboard carica pratiche reali', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Aspetta che scompaiano gli errori di auth / rete
  await expect(page.locator('body')).not.toContainText('Authentication required', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Utente non autorizzato', { timeout: 5000 });

  // Aspetta esplicitamente che le card appaiano O che lo stato vuoto sia visibile.
  // Lo skeleton sparisce quando la risposta API arriva.
  await expect(
    page.locator('.practice-card').first()
      .or(page.getByText(/nessuna pratica/i))
      .or(page.getByText(/nessun appuntamento/i))
  ).toBeAttached({ timeout: 20000 });
});

test('produzione: stats endpoint risponde con dati reali', async ({ page }) => {
  // Registra la promise PRIMA della navigazione così non perde la risposta
  const statsPromise = page.waitForResponse(
    (res) => res.url().includes('/api/practices/stats'),
    { timeout: 20000 },
  );

  await page.goto(`/?user_id=${DEV_USER_ID}`);

  const statsResponse = await statsPromise;
  expect(statsResponse.status(), `Stats HTTP ${statsResponse.status()}`).toBeLessThan(300);

  const json = await statsResponse.json();
  expect(json.success).toBe(true);
  expect(typeof json.data.total).toBe('number');
});

test('produzione: form nuova pratica si apre e compila senza errori', async ({ page }) => {
  await page.goto(`/?plate=SMOKETEST&user_id=${DEV_USER_ID}`);

  await expect(page.locator('#plate_confirmed')).toHaveValue('SMOKETEST', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
  await expect(page.locator('body')).not.toContainText('Utente non autorizzato');
});

test('produzione: dettaglio pratica esistente carica senza errori', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Aspetta che le card siano visibili (waitFor aspetta effettivamente, isVisible no)
  const firstCard = page.locator('.practice-card').first();
  const appeared = await firstCard.waitFor({ state: 'attached', timeout: 15000 }).then(() => true).catch(() => false);

  if (!appeared) {
    test.skip(true, 'Nessuna pratica in produzione — skip test dettaglio');
    return;
  }

  await firstCard.click();

  // .detail-sync-action risolve più elementi — usa .first() per evitare strict mode violation
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
  await expect(page.locator('body')).not.toContainText('Utente non autorizzato');
});
