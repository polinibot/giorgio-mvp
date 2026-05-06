const { test, expect } = require('@playwright/test');

const API_URL = process.env.SMOKE_API_URL || 'http://127.0.0.1:8000';

async function resetMockState(request) {
  const response = await request.post(`${API_URL}/__reset`);
  expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await resetMockState(request);
});

test('dashboard filters, search, detail and back work on the built app', async ({ page }) => {
  await page.goto('/?user_id=761118078');

  await expect(page.locator('.practice-card')).toHaveCount(2);
  await page.locator('.search-input').fill('Mario');
  await expect(page.locator('.practice-card')).toHaveCount(1);
  await expect(page.locator('.practice-card')).toContainText('Mario Rossi');

  await page.locator('.search-input').fill('');
  await expect(page.locator('.practice-card')).toHaveCount(2);

  await page.getByRole('button', { name: 'Carrozzeria' }).click();
  await expect(page.locator('.practice-card')).toHaveCount(1);
  await expect(page.locator('.practice-card')).toContainText('Luca Bianchi');

  await page.getByRole('button', { name: 'Carrozzeria' }).click();
  await expect(page.locator('.practice-card')).toHaveCount(2);

  await page.locator('.practice-card').first().click();
  await expect(page.locator('.detail-actions')).toBeVisible();
  await expect(page.locator('body')).toContainText('Filtro olio');

  await page.getByRole('button', { name: /Indietro/i }).first().click();
  await expect(page.locator('.practice-card')).toHaveCount(2);
});

test('editing an existing practice in the real browser preserves descriptive rows', async ({ page }) => {
  await page.goto('/?practice_id=1&user_id=761118078');

  const descriptionInput = page.getByPlaceholder('Descrizione lavoro...').first();
  await expect(descriptionInput).toHaveValue('Tagliando');

  await page.locator('#notes_officina').fill('Nota aggiornata smoke');
  await page.getByRole('button', { name: 'Aggiorna' }).click();

  await expect(page.locator('body')).toContainText('Pratica aggiornata con successo!');
  await expect(page.locator('body')).not.toContainText('Inserisci almeno una riga descrittiva per officina');
});

test('draft data survives a real browser reload', async ({ page }) => {
  await page.goto('/?plate=ZX321TY');

  await page.locator('#phone').fill('3331234567');
  await page.locator('#customer_name').fill('Cliente Smoke');
  await page.getByRole('checkbox', { name: 'Officina' }).check();
  await page.getByPlaceholder('Descrizione lavoro...').first().fill('Controllo generale smoke');

  await page.waitForTimeout(900);
  await page.reload();

  await expect(page.locator('#phone')).toHaveValue('3331234567');
  await expect(page.locator('#customer_name')).toHaveValue('Cliente Smoke');
  await expect(page.getByRole('checkbox', { name: 'Officina' })).toBeChecked();
  await expect(page.getByPlaceholder('Descrizione lavoro...').first()).toHaveValue('Controllo generale smoke');
});

test('demo mode can be submitted end-to-end on the production build output', async ({ page }) => {
  await page.goto('/?demo=complete&user_id=761118078');

  await expect(page.locator('#plate_confirmed')).toHaveValue('AB123CD');
  await page.getByRole('button', { name: 'Salva' }).click();

  await expect(page.locator('body')).toContainText('Pratica creata con successo!');
  await expect(page.locator('.practice-card')).toHaveCount(3);
});
