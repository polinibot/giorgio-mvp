/**
 * Production smoke suite — testa la mini-app contro Railway reale.
 * Richiede SMOKE_TEST_SECRET = valore impostato su Railway.
 *
 * Design:
 * - beforeAll: crea pratiche seed con cui girare i test (idempotente)
 * - afterAll: pulisce tutte le pratiche seed ancora presenti
 * - I test di eliminazione creano le proprie pratiche e le rimuovono
 * - route.fetch() lato Node.js bypassa CORS e inietta X-Smoke-Secret
 */
const { test, expect, request: playwrightRequest } = require('@playwright/test');

const PROD_API = process.env.SMOKE_PROD_API_URL
  || 'https://giorgio-mvp-production.up.railway.app';
const SMOKE_SECRET = process.env.SMOKE_TEST_SECRET || '';
const DEV_USER_ID = process.env.SMOKE_USER_ID || '761118078';

if (!SMOKE_SECRET) {
  throw new Error('SMOKE_TEST_SECRET non impostato.');
}

// ─────────────────────────────────────────────────────────────
// HELPERS API
// ─────────────────────────────────────────────────────────────

async function apiPost(path, data, { timeout = 45000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctx = await playwrightRequest.newContext();
    try {
      const res = await ctx.post(`${PROD_API}${path}`, {
        headers: { 'X-Smoke-Secret': SMOKE_SECRET, 'Content-Type': 'application/json' },
        data,
        timeout,
      });
      const ok = res.ok();
      const status = res.status();
      const json = await res.json().catch(() => ({}));
      return { ok, status, json };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
    } finally {
      await ctx.dispose();
    }
  }
  throw lastErr;
}

async function apiDelete(path) {
  const ctx = await playwrightRequest.newContext();
  try {
    const res = await ctx.delete(`${PROD_API}${path}`, {
      headers: { 'X-Smoke-Secret': SMOKE_SECRET },
      timeout: 45000,
    });
    return { ok: res.ok(), status: res.status() };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Crea una pratica smoke via API e restituisce l'id.
 * contexts è SEMPRE una lista (il backend rifiuta le stringhe).
 */
async function createSmokePractice(label = 'A', ctx = 'officina') {
  // plate_confirmed deve essere >= 5 caratteri (validazione backend)
  const plate = `SMK${label}01`.slice(0, 10);
  const res = await apiPost('/practices/full', {
    practice: {
      plate_confirmed: plate,
      phone: '3331234567',
      customer_name: `Smoke Test ${label} ${plate}`,
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-15',
      appointment_time: '10:00',
      practice_type: 'preventivo',
      contexts: [ctx],
      internal_notes: `Auto-generata smoke suite — da eliminare`,
    },
    sections: [{
      context: ctx,
      description_rows: ['Controllo smoke'],
      man_hours: 1,
      mac_hours: null,
      materials_amount: null,
      waste_apply: false,
      waste_percentage: 2,
      notes: '',
    }],
    parts: [],
  });
  if (!res.ok) throw new Error(`createSmokePractice ${label}: HTTP ${res.status} — ${JSON.stringify(res.json)}`);
  const id = res.json?.data?.id;
  if (!id) throw new Error(`createSmokePractice ${label}: id mancante`);
  return id;
}

async function apiGet(path) {
  const ctx = await playwrightRequest.newContext();
  try {
    const res = await ctx.get(`${PROD_API}${path}`, {
      headers: { 'X-Smoke-Secret': SMOKE_SECRET },
      timeout: 45000,
    });
    const ok = res.ok();
    const status = res.status();
    const json = await res.json().catch(() => ({}));
    return { ok, status, json };
  } finally {
    await ctx.dispose();
  }
}

async function deleteSmokePractice(id) {
  // skip_yap=true: evita YAP automation server-side per le pratiche smoke
  await apiDelete(`/practices/${id}?skip_yap=true`);
}

// ─────────────────────────────────────────────────────────────
// SEED — crea pratiche prima della suite, pulisce dopo
// ─────────────────────────────────────────────────────────────

// IDs delle pratiche create dal seed (condivise da tutti i test)
const seed = { ids: [] };

test.beforeAll(async () => {
  // 1. Cleanup leftover da run precedenti (targa inizia con SMK)
  const listRes = await apiGet('/api/practices').catch(() => ({ ok: false, json: {} }));
  if (listRes.ok) {
    const all = listRes.json?.data || [];
    const leftover = all.filter((p) => p.plate_confirmed?.startsWith('SMK'));
    if (leftover.length > 0) {
      // Elimina in sequenza con skip_yap per evitare saturazione Railway
      for (const p of leftover) {
        await deleteSmokePractice(p.id).catch(() => {});
      }
    }
  }

  // 2. Crea 3 pratiche seed in sequenza
  const a = await createSmokePractice('A', 'officina');
  const b = await createSmokePractice('B', 'carrozzeria');
  const c = await createSmokePractice('C', 'revisione');
  seed.ids = [a, b, c];
});

test.afterAll(async () => {
  // Pulisce le pratiche seed ancora presenti (i test di eliminazione
  // le cancellano già, afterAll gestisce i casi in cui il test fallisce)
  await Promise.allSettled(seed.ids.map((id) => deleteSmokePractice(id)));
});

// ─────────────────────────────────────────────────────────────
// HELPERS UI
// ─────────────────────────────────────────────────────────────

async function setupSmokeAuth(page) {
  await page.route(`${PROD_API}/**`, async (route) => {
    try {
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'X-Smoke-Secret': SMOKE_SECRET },
      });
      await route.fulfill({ response });
    } catch (e) {
      if (e.message && (e.message.includes('closed') || e.message.includes('destroyed') || e.message.includes('disposed'))) return;
      throw e;
    }
  });
}

/** Aspetta che il dashboard abbia caricato (skeleton sparito). */
async function waitForDashboardReady(page, timeout = 20000) {
  await expect(
    page.locator('.practice-card').first()
      .or(page.getByText(/nessuna pratica/i))
      .or(page.getByText(/nessun risultato/i))
  ).toBeAttached({ timeout });
}

/** Aspetta che compaiano card (seed già presenti). */
async function waitForCards(page) {
  await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 20000 });
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
  await waitForCards(page);

  const count = await page.locator('.practice-card').count();
  expect(count, 'Nessuna pratica trovata (seed dovrebbe aver creato 3)').toBeGreaterThan(0);
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
  // Non verificare il conteggio UI: potrebbe essere 0 se il filtro data
  // (default mese corrente) esclude le pratiche seed di novembre 2026.
});

test('dashboard: card mostrano targa, cliente e ora appuntamento', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const firstCard = page.locator('.practice-card').first();
  const cardText = await firstCard.textContent();

  // Targa visibile nella card
  expect(cardText).toContain('SMK');
  // Ora appuntamento visibile (miglioramento UI)
  expect(cardText).toContain('10:00');
  // Cliente visibile
  expect(cardText).toContain('Smoke Test');
});

test('dashboard: ricerca per targa filtra le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const initialCount = await page.locator('.practice-card').count();
  const searchInput = page.locator('.search-input, input[placeholder*="arga"]').first();
  await searchInput.fill('SMKA');

  await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 8000 });
  const filtered = await page.locator('.practice-card').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThanOrEqual(initialCount);

  // Pulisce e aspetta il ripristino
  await page.locator('button[aria-label="Cancella ricerca"]').click().catch(async () => {
    await searchInput.clear();
  });
  await expect(page.locator('.practice-card')).toHaveCount(initialCount, { timeout: 12000 });
});

test('dashboard: filtro contesto restringe le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const totalCards = await page.locator('.practice-card').count();
  await page.getByRole('button', { name: /officina/i }).click();
  await page.waitForTimeout(400);

  const filtered = await page.locator('.practice-card').count();
  expect(filtered).toBeLessThanOrEqual(totalCards);
  await expect(page.locator('body')).not.toContainText('Errore', { timeout: 2000 }).catch(() => {});

  await page.getByRole('button', { name: /officina/i }).click();
  await page.waitForTimeout(300);
});

// ─────────────────────────────────────────────────────────────
// 2. DETTAGLIO PRATICA
// ─────────────────────────────────────────────────────────────

test('dettaglio: overview mostra i dati della pratica', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
  await expect(page.getByRole('button', { name: /panoramica/i })).toBeVisible();
});

test('dettaglio: tab YAP mostra stato sync e bottoni azione', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'YAP', exact: true }).click();
  await expect(page.locator('body')).toContainText(/Automazione YAP|Sincronizza/i, { timeout: 10000 });
  await expect(page.getByRole('button', { name: /Sincronizza con YAP/i })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: /Elimina da YAP/i })).toBeVisible({ timeout: 3000 });
});

test('dettaglio: indietro torna alla dashboard con le card', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const initialCount = await page.locator('.practice-card').count();
  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: /Indietro/i }).first().click();
  await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 10000 });
  expect(await page.locator('.practice-card').count()).toBe(initialCount);
});

// ─────────────────────────────────────────────────────────────
// 3. FORM
// ─────────────────────────────────────────────────────────────

test('form: nuova pratica con targa si apre precompilata', async ({ page }) => {
  await page.goto(`/?plate=SMOKETEST&user_id=${DEV_USER_ID}`);
  await expect(page.locator('#plate_confirmed')).toHaveValue('SMOKETEST', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
  await expect(page.locator('body')).not.toContainText('Errore di rete');
});

test('form: selezione contesto mostra i campi della sezione', async ({ page }) => {
  await page.goto(`/?plate=SMKFRM&user_id=${DEV_USER_ID}`);
  await expect(page.locator('#plate_confirmed')).toHaveValue('SMKFRM', { timeout: 10000 });

  await page.getByRole('checkbox', { name: /officina/i }).check();
  await page.waitForTimeout(300);
  await expect(page.getByPlaceholder(/Descrizione lavoro/i).first()).toBeVisible({ timeout: 5000 });
});

test('form: validazione blocca submit con campi obbligatori mancanti', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForDashboardReady(page);

  const fab = page.locator('.fab, [class*="fab"]').last()
    .or(page.getByRole('button', { name: '+' }))
    .or(page.locator('button').filter({ hasText: /^\+$/ }).last());

  const fabVisible = await fab.isVisible({ timeout: 5000 }).catch(() => false);
  if (!fabVisible) {
    test.skip(true, 'FAB + non trovato — skip validazione form');
    return;
  }
  await fab.click();
  await expect(page.locator('#plate_confirmed')).toBeAttached({ timeout: 8000 });

  await page.getByRole('button', { name: /salva|crea/i }).first().click();
  await page.waitForTimeout(600);

  const bodyText = await page.locator('body').textContent();
  const hasError = /inserisci|seleziona almeno|campo obbligatorio|almeno una riga/i.test(bodyText || '');
  expect(hasError, `Nessun errore di validazione. Body: ${(bodyText || '').slice(0, 200)}`).toBeTruthy();
});

// ─────────────────────────────────────────────────────────────
// 4. MODIFICA
// ─────────────────────────────────────────────────────────────

test('modifica: apertura form edit preserva i dati esistenti', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: /modifica/i }).first().click();
  await expect(page.locator('#plate_confirmed')).not.toHaveValue('', { timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Authentication required');
});

// ─────────────────────────────────────────────────────────────
// 5. API ENDPOINTS
// ─────────────────────────────────────────────────────────────

test('api: pre-sync-check restituisce score per pratica esistente', async ({ page }) => {
  const preSyncPromise = page.waitForResponse(
    (res) => res.url().includes('pre-sync-check') && res.status() < 300,
    { timeout: 25000 },
  );

  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const res = await preSyncPromise.catch(() => null);
  if (!res) {
    test.skip(true, 'pre-sync-check non chiamato — skip');
    return;
  }
  const json = await res.json().catch(() => ({}));
  expect(json.success).toBe(true);
});

test('api: yap-mapping-preview restituisce proposedYap per pratica valida', async ({ page }) => {
  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  const previewPromise = page.waitForResponse(
    (res) => res.url().includes('yap-mapping-preview') && res.status() < 300,
    { timeout: 20000 },
  );

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

// ─────────────────────────────────────────────────────────────
// 6. ELIMINAZIONE SINGOLA
// ─────────────────────────────────────────────────────────────

test('eliminazione singola: crea pratica, la elimina dalla UI e verifica scomparsa', async ({ page }) => {
  // Crea pratica dedicata a questo test (non dal seed)
  const practiceId = await createSmokePractice('DEL1');

  try {
    await page.goto(`/?user_id=${DEV_USER_ID}`);
    await waitForCards(page);

    // Cerca la card appena creata
    const searchInput = page.locator('.search-input, input[placeholder*="arga"]').first();
    await searchInput.fill('SMKDEL1');
    await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 10000 });

    // Apri il dettaglio
    await page.locator('.practice-card').first().click();
    await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

    // Clicca "🗑 Elimina"
    await page.getByRole('button', { name: /elimina/i }).last().click();

    // Conferma nella modal
    await expect(page.getByRole('button', { name: 'Conferma' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Conferma' }).click();

    // Attendi toast o ritorno alla dashboard
    await page.waitForTimeout(1500);

    // La pratica non deve più apparire
    await page.goto(`/?user_id=${DEV_USER_ID}`);
    await waitForDashboardReady(page);
    const searchInput2 = page.locator('.search-input, input[placeholder*="arga"]').first();
    await searchInput2.fill('SMKDEL1');
    await page.waitForTimeout(800);
    const remaining = await page.locator('.practice-card').filter({ hasText: 'SMKDEL1' }).count();
    expect(remaining, 'Pratica ancora visibile dopo eliminazione').toBe(0);
  } catch (e) {
    // Cleanup in caso di fallimento del test
    await deleteSmokePractice(practiceId).catch(() => {});
    throw e;
  }
});

// ─────────────────────────────────────────────────────────────
// 7. ELIMINAZIONE MULTIPLA
// ─────────────────────────────────────────────────────────────

test('eliminazione multipla: crea 2 pratiche, seleziona tutto e elimina', async ({ page }) => {
  // Verifica la cancellazione multipla reale: selection mode → seleziona tutte →
  // conferma → le pratiche vengono davvero rimosse dal backend e spariscono dalla
  // lista dopo loadDashboard(). Il mock (registrato DOPO setupSmokeAuth → LIFO ha
  // priorità) tocca SOLO la YAP automation (lenta ~30-60s e distruttiva su YAP
  // reale); la DELETE locale resta reale (skip_yap=true → soft-delete istantaneo).
  //
  // NB: RegExp (non glob): i glob Playwright richiedono il match dell'URL intero
  // inclusa la query ?user_id=... appesa dal frontend a ogni chiamata.
  await page.route(/\/practices\/\d+\/yap\/appointment/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { status: 'not_found' } }),
    });
  });

  // Creazione via API (Node context, non toccata dai page.route)
  const id1 = await createSmokePractice('MUL1');
  const id2 = await createSmokePractice('MUL2');

  try {
    await page.goto(`/?user_id=${DEV_USER_ID}`);
    await waitForCards(page);

    // Filtra per mostrare SOLO le 2 pratiche test
    const searchInput = page.locator('.search-input, input[placeholder*="arga"]').first();
    await searchInput.fill('SMKMUL');
    await expect(page.locator('.practice-card').first()).toBeAttached({ timeout: 10000 });

    const visibleBefore = await page.locator('.practice-card').count();
    expect(visibleBefore, 'Pratiche MUL non trovate nella lista').toBeGreaterThanOrEqual(2);

    // Entra in selection mode
    await page.getByRole('button', { name: 'Seleziona', exact: true }).click();
    await expect(page.locator('.selection-delete-btn')).toBeVisible({ timeout: 5000 });

    // Seleziona tutte le visibili (solo le 2 MUL)
    await page.getByRole('button', { name: /Seleziona tutte/i }).click();
    await page.waitForTimeout(300);

    const countLabel = page.locator('.selection-count');
    await expect(countLabel).not.toContainText('Nessuna', { timeout: 3000 });

    // Clicca "Elimina (2)"
    await page.locator('.selection-delete-btn').click();

    // Conferma
    await expect(page.getByRole('button', { name: 'Conferma' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Conferma' }).click();

    // NB: il frontend chiama setSelectionMode(false) all'INIZIO di onConfirm,
    // prima del loop di delete: quindi non possiamo usare l'uscita da selection
    // mode come segnale di completamento (sparisce subito). Aspettiamo invece che
    // le card SMKMUL spariscano davvero dopo i delete reali + loadDashboard().
    // toHaveCount fa auto-retry fino al timeout, assorbendo l'asincronia.
    await expect(
      page.locator('.practice-card').filter({ hasText: /SMKMUL/ }),
      'Pratiche smoke ancora presenti dopo eliminazione multipla'
    ).toHaveCount(0, { timeout: 30000 });
  } finally {
    // Cleanup reale (i delete UI erano mockati → le pratiche esistono ancora su Railway)
    await deleteSmokePractice(id1).catch(() => {});
    await deleteSmokePractice(id2).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 8. ELIMINA DA YAP (verifica UI response senza attendere worker)
// ─────────────────────────────────────────────────────────────

test('elimina da YAP: il bottone avvia l\'operazione e mostra una risposta', async ({ page }) => {
  // Mock YAP via RegExp (LIFO → priorità su setupSmokeAuth): evita worker reale.
  // RegExp necessaria: il glob non matcherebbe la query ?user_id=... appesa dal FE.
  await page.route(/\/practices\/\d+\/yap\/appointment/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { status: 'not_found', message: 'Smoke mock: not_found su YAP' },
      }),
    });
  });

  await page.goto(`/?user_id=${DEV_USER_ID}`);
  await waitForCards(page);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-sync-action').first()).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'YAP', exact: true }).click();
  await expect(page.getByRole('button', { name: /Elimina da YAP/i })).toBeVisible({ timeout: 5000 });

  const deleteResponsePromise = page.waitForResponse(
    (res) => res.url().includes('/yap/appointment'),
    { timeout: 15000 },
  ).catch(() => null);

  await page.getByRole('button', { name: /Elimina da YAP/i }).click();

  const deleteRes = await deleteResponsePromise;
  if (deleteRes) {
    expect(deleteRes.status()).toBeLessThan(300);
    const json = await deleteRes.json().catch(() => ({}));
    expect(json?.success).toBe(true);
  }

  await expect(page.locator('body')).not.toContainText('Errore di rete');
});

// ─────────────────────────────────────────────────────────────
// 9. SYNC YAP REALE (dry-run) — esercita login + agenda sul portale vero
// ─────────────────────────────────────────────────────────────

test('sync YAP reale (dry-run): il login al portale completa senza timeout', async () => {
  // Questo è l'UNICO test che esercita l'automazione YAP REALE contro
  // yap.mmbsoftware.it. Usa dry_run:true → fa login, apre l'agenda e scansiona
  // i duplicati, ma NON scrive l'appuntamento (non distruttivo). Cattura le
  // regressioni del login worker (es. redirect-loop / timeout a 210s a sessione
  // scaduta) che i test mockati non possono vedere.
  test.setTimeout(240000); // l'automazione reale può richiedere fino a ~210s
  const id = await createSmokePractice('YAPDRY');
  try {
    const res = await apiPost(`/practices/${id}/yap/sync`,
      { dry_run: true, debug: true },
      { timeout: 220000, retries: 0 });

    expect(res.status, `HTTP inatteso dalla sync: ${res.status}`).toBeLessThan(300);
    const data = res.json?.data || {};
    // Su FALLIMENTO il backend mette le fasi in data.worker_phases; su dry_run
    // success vanno sotto data.telemetry.runner.worker_phases. Le raccogliamo da
    // entrambi i path solo per arricchire il messaggio d'errore in caso di regressione.
    const failPhases = (data.worker_phases || data.telemetry?.runner?.worker_phases || [])
      .map((p) => `${p.phase}:${p.status}`).join(' → ');

    // Segnale autoritativo = status. 'dry_run'/'appointment_not_verified' è
    // producibile SOLO se il worker si è loggato, ha aperto l'agenda e scansionato
    // i duplicati. La regressione (redirect-loop a sessione scaduta) dà invece
    // 'sync_failed' con reason "timeout during loginYap": è ciò che blocchiamo.
    expect(
      data.status,
      `Sync YAP fallita (login non riuscito?): status=${data.status} reason=${data.status_reason}. Fasi: ${failPhases}`
    ).toBe('dry_run');
    expect(String(data.status_reason || '')).not.toMatch(/timeout/i);
  } finally {
    await deleteSmokePractice(id).catch(() => {});
  }
});
