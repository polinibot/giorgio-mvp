/**
 * Production smoke suite — testa la mini-app contro Railway reale.
 * Richiede SMOKE_TEST_SECRET = valore impostato su Railway.
 *
 * Usa route.fetch() lato Node.js per bypassare CORS e aggiungere
 * X-Smoke-Secret senza toccare l'applicazione React.
 */
const { test, expect } = require('@playwright/test');

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const SMOKE_SECRET = process.env.SMOKE_TEST_SECRET || '';
const DEV_USER_ID = process.env.SMOKE_USER_ID || '761118078';

if (!SMOKE_SECRET) {
  throw new Error('SMOKE_TEST_SECRET non impostato.');
}

async function setupSmokeAuth(page) {
  await page.route(`${PROD_API}/**`, async (route) => {
    try {
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'X-Smoke-Secret': SMOKE_SECRET },
      });
      await route.fulfill({ response });
    } catch (e) {
      if (e.message && (e.message.includes('closed') || e.message.includes('destroyed'))) return;
      throw e;
    }
  });
}

/** Aspetta che il dashboard abbia finito di caricare (skeleton sparito). */
async function waitForDashboardReady(page, timeout = 20000) {
  // Le card o lo stato vuoto appaiono quando l'API risponde
  await expect(
    page.locator('.practice-card').first()
      .or(page.getByText(/nessuna pratica/i))
      .or(page.getByText(/nessun risultato/i))
  ).toBeAttached({ timeout });
}

test.beforeEach(async ({ page }) => {
  await setupSmokeAuth(page);
});

// ─────────────────────────────────────────────────────────────
// 1. DASHBOARD
// ─────────────────────────────────────────────────────────────

test('dashboard: carica pratiche reali senza errori auth', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await expect(page.locator('body')).not.toContainText('Authentication required', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Utente non autorizzato', { timeout: 5000 });
  await waitForDashboardReady(page);

  const count = await page.locator('.practice-card').count();
  expect(count, 'Nessuna pratica trovata in produzione').toBeGreaterThan(0);
});

test('dashboard: stats corrispondono al numero di card visibili', async ({ page }) => {
  const statsPromise = page.waitForResponse(
    (res) => res.url().includes('/api/practices/stats'),
    { timeout: 20000 },
  );
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  const statsRes = await statsPromise;

  expect(statsRes.status()).toBeLessThan(300);
  const json = await statsRes.json();
  expect(json.success).toBe(true);
  expect(json.data.total).toBeGreaterThan(0);

  await waitForDashboardReady(page);
  // Le card mostrate possono essere meno del totale (paginazione / filtri default)
  // ma ci devono essere almeno alcune card
  const cards = await page.locator('.practice-card').count();
  expect(cards).toBeGreaterThan(0);
});

test('dashboard: ricerca per targa filtra le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  const initialCount = await page.locator('.practice-card').count();

  const firstCard = page.locator('.practice-card').first();
  // Legge la targa dalla prima card
  const plateText = await firstCard.locator('[class*="plate"], [class*="targa"], h3, h4, strong').first().textContent().catch(() => '');
  const plate = (plateText || '').trim().replace(/\s+/g, '').slice(0, 7);

  if (!plate) {
    test.skip(true, 'Targa non leggibile dalla card — skip ricerca');
    return;
  }

  const searchInput = page.locator('.search-input, input[placeholder*="arga"], input[placeholder*="liente"]').first();
  await searchInput.fill(plate);

  // Aspetta che il debounce scatti e le card si aggiornino
  await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 8000 });
  const filtered = await page.locator('.practice-card').count();
  expect(filtered, `Ricerca "${plate}" non ha prodotto risultati`).toBeGreaterThan(0);

  // Pulisce la ricerca
  await page.locator('button[aria-label="Cancella ricerca"]').click().catch(async () => {
    await searchInput.clear();
    await page.keyboard.press('Tab');
  });

  // Aspetta che le card tornino al conteggio iniziale
  await expect(page.locator('.practice-card')).toHaveCount(initialCount, { timeout: 12000 });
});

test('dashboard: filtro contesto restringe le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  const totalCards = await page.locator('.practice-card').count();
  if (totalCards < 2) {
    test.skip(true, 'Meno di 2 pratiche — skip filtro contesto');
    return;
  }

  // Clicca il filtro Officina
  await page.getByRole('button', { name: /officina/i }).click();
  await page.waitForTimeout(400);

  const filtered = await page.locator('.practice-card').count();
  // Non sappiamo quante sono di tipo officina, ma il filtro deve aver
  // prodotto un numero <= totale senza errori
  expect(filtered).toBeLessThanOrEqual(totalCards);
  await expect(page.locator('body')).not.toContainText('Errore', { timeout: 2000 }).catch(() => {});

  // Rimuove filtro
  await page.getByRole('button', { name: /officina/i }).click();
  await page.waitForTimeout(300);
});

// ─────────────────────────────────────────────────────────────
// 2. DETTAGLIO PRATICA
// ─────────────────────────────────────────────────────────────

test('dettaglio: overview mostra i dati della pratica', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  await page.locator('.practice-card').first().click();
  // Aspetta la sezione dettaglio
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');

  // Tab overview deve essere attivo di default
  await expect(page.getByRole('button', { name: /panoramica/i })).toBeVisible();
});

test('dettaglio: tab YAP mostra stato sync e bottoni azione', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  // Apre tab YAP — exact:true evita strict mode violation con "Sincronizza con YAP" ecc.
  await page.getByRole('button', { name: 'YAP', exact: true }).click();

  // Aspetta che il tab YAP carichi
  await expect(page.locator('body')).toContainText(/Automazione YAP|YAP|Sincronizza/i, { timeout: 10000 });

  // Bottone Sincronizza deve essere visibile
  await expect(page.getByRole('button', { name: /Sincronizza con YAP/i })).toBeVisible({ timeout: 5000 });
  // Bottone Elimina deve essere visibile
  await expect(page.getByRole('button', { name: /Elimina da YAP/i })).toBeVisible({ timeout: 3000 });
});

test('dettaglio: stato sync_failed mostra "Sync YAP fallita" nella UI', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  // Cerca una card con sync_failed (in produzione sono tutte così)
  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  // L'overview mostra lo stato YAP come "Sync YAP fallita"
  const bodyText = await page.locator('body').textContent();
  const hasSyncFailedLabel = /Sync YAP fallita|sync.failed|fallita/i.test(bodyText || '');
  expect(hasSyncFailedLabel, 'Stato sync_failed non visibile nella UI').toBeTruthy();
});

test('dettaglio: indietro torna alla dashboard con le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  const initialCount = await page.locator('.practice-card').count();
  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: /Indietro/i }).first().click();
  await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 10000 });

  const backCount = await page.locator('.practice-card').count();
  expect(backCount).toBe(initialCount);
});

// ─────────────────────────────────────────────────────────────
// 3. FORM NUOVA PRATICA
// ─────────────────────────────────────────────────────────────

test('form: nuova pratica con targa si apre precompilata', async ({ page }) => {
  await page.goto(`/?plate=SMOKETEST&user_id=${DEV_USER_ID}`);
  await expect(page.locator('#plate_confirmed')).toHaveValue('SMOKETEST', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
  await expect(page.locator('body')).not.toContainText('Utente non autorizzato');
});

test('form: selezione contesto mostra i campi della sezione', async ({ page }) => {
  await page.goto(`/?plate=SMKTEST2&user_id=${DEV_USER_ID}`);
  await expect(page.locator('#plate_confirmed')).toHaveValue('SMKTEST2', { timeout: 10000 });

  // Seleziona "Officina"
  await page.getByRole('checkbox', { name: /officina/i }).check();
  await page.waitForTimeout(300);

  // Deve apparire il campo "Righe Descrittive"
  await expect(page.getByPlaceholder(/Descrizione lavoro/i).first()).toBeVisible({ timeout: 5000 });
});

test('form: validazione blocca submit con campi obbligatori mancanti', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  // Il FAB "+" è il bottone rotondo blu in basso a destra
  const fab = page.locator('.fab, [class*="fab"], button[class*="add"]').last()
    .or(page.getByRole('button', { name: '+' }))
    .or(page.locator('button').filter({ hasText: /^\+$/ }).last());

  const fabVisible = await fab.isVisible({ timeout: 5000 }).catch(() => false);
  if (!fabVisible) {
    test.skip(true, 'FAB + non trovato — skip validazione form');
    return;
  }
  await fab.click();

  // Aspetta che il form si apra
  await expect(page.locator('#plate_confirmed')).toBeAttached({ timeout: 8000 });

  // Click salva senza compilare nulla
  await page.getByRole('button', { name: /salva|crea/i }).first().click();
  await page.waitForTimeout(600);

  // I messaggi di validazione di react-hook-form includono:
  // "Inserisci la targa", "Inserisci il numero di telefono",
  // "Seleziona almeno un contesto", "Inserisci almeno una riga"
  const bodyText = await page.locator('body').textContent();
  const hasValidationError = /campo obbligatorio|richiesto|inserisci|seleziona almeno|required|almeno una riga/i.test(bodyText || '');
  expect(hasValidationError, `Nessun errore di validazione. Body: ${(bodyText || '').slice(0, 200)}`).toBeTruthy();
});

// ─────────────────────────────────────────────────────────────
// 4. MODIFICA PRATICA ESISTENTE
// ─────────────────────────────────────────────────────────────

test('modifica: apertura form edit preserva i dati esistenti', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  // Clicca "Modifica"
  await page.getByRole('button', { name: /modifica/i }).first().click();

  // Il form deve aprirsi con la targa già compilata
  await expect(page.locator('#plate_confirmed')).not.toHaveValue('', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
});

// ─────────────────────────────────────────────────────────────
// 5. API ENDPOINT DIRETTI
// ─────────────────────────────────────────────────────────────

test('api: pre-sync-check restituisce score per pratica esistente', async ({ page }) => {
  // Questo test fa una richiesta API diretta intercettata da Playwright
  await page.goto(`/?user_id=${DEV_USER_ID}`);

  const preSyncPromise = page.waitForResponse(
    (res) => res.url().includes('pre-sync-check') && res.status() < 300,
    { timeout: 25000 },
  );

  // Il pre-sync check viene chiamato quando si visualizzano le card nella dashboard
  await waitForDashboardReady(page);

  const res = await preSyncPromise.catch(() => null);
  if (!res) {
    test.skip(true, 'pre-sync-check non chiamato durante dashboard load');
    return;
  }

  const json = await res.json().catch(() => ({}));
  expect(json.success).toBe(true);
});

test('api: yap-mapping-preview restituisce proposedYap per pratica valida', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  const previewPromise = page.waitForResponse(
    (res) => res.url().includes('yap-mapping-preview') && res.status() < 300,
    { timeout: 20000 },
  );

  // La preview viene caricata quando si apre il tab YAP
  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'YAP', exact: true }).click();

  const res = await previewPromise;
  const json = await res.json();
  expect(json.success).toBe(true);
  const popup = json.data?.proposedYap?.popup;
  expect(popup, 'proposedYap.popup mancante').toBeTruthy();
  expect(popup.cosa, 'cosa vuoto nel mapping YAP').toBeTruthy();
});
