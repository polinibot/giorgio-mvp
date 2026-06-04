/**
 * Smoke test su produzione reale.
 * Richiede SMOKE_TEST_SECRET = valore impostato in Railway su SMOKE_TEST_SECRET.
 * Playwright intercetta ogni richiesta verso l'API di produzione e aggiunge
 * l'header X-Smoke-Secret, bypassando l'autenticazione Telegram.
 */
const { test, expect } = require('@playwright/test');

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const SMOKE_SECRET = process.env.SMOKE_TEST_SECRET || '';
const DEV_USER_ID = process.env.SMOKE_USER_ID || '761118078';

if (!SMOKE_SECRET) {
  throw new Error(
    'SMOKE_TEST_SECRET non impostato. Aggiungilo al .env o come variabile d\'ambiente.'
  );
}

/** Intercetta tutte le richieste verso PROD_API e aggiunge il bypass header. */
async function setupSmokeAuth(page) {
  await page.route(`${PROD_API}/**`, async (route) => {
    const headers = {
      ...route.request().headers(),
      'X-Smoke-Secret': SMOKE_SECRET,
    };
    await route.continue({ headers });
  });
}

test.beforeEach(async ({ page }) => {
  await setupSmokeAuth(page);
});

test('produzione: dashboard carica pratiche reali', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Attende che la dashboard carichi (pratiche reali o empty state)
  await expect(page.locator('body')).not.toContainText('Errore di rete', { timeout: 15000 });
  await expect(page.locator('body')).not.toContainText('Authentication required', { timeout: 5000 });

  // La dashboard deve mostrare o practice-card oppure il messaggio "nessuna pratica"
  const hasCards = await page.locator('.practice-card').count();
  const hasEmpty = await page.locator('body').evaluate(
    (body) => body.textContent.includes('nessuna') || body.textContent.includes('Nessuna')
  );
  expect(hasCards > 0 || hasEmpty).toBeTruthy();
});

test('produzione: stats endpoint risponde correttamente', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Intercetta la risposta di stats
  const statsResponse = await page.waitForResponse(
    (res) => res.url().includes('/api/practices/stats') && res.status() < 300,
    { timeout: 15000 }
  );
  const json = await statsResponse.json();
  expect(json.success).toBe(true);
  expect(typeof json.data.total).toBe('number');
});

test('produzione: form nuova pratica si apre e carica correttamente', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Clicca "Nuova pratica" o va direttamente con plate param
  await page.goto(`/?plate=SMOKETEST&user_id=${DEV_USER_ID}`);
  await expect(page.locator('#plate_confirmed')).toHaveValue('SMOKETEST', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
});

test('produzione: dettaglio pratica esistente carica senza errori', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  // Attende che ci siano pratiche
  await page.waitForTimeout(3000);
  const cardCount = await page.locator('.practice-card').count();

  if (cardCount === 0) {
    test.skip(true, 'Nessuna pratica in produzione — skip test dettaglio');
    return;
  }

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-actions, .detail-sync-action')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
});
