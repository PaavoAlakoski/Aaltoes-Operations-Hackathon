// The main flow, end to end against the real database: open the queue, open
// CD-420593, approve the agent's proposal, see the numbered outcome, check a
// second decision is refused, undo it on the order page.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8')
    .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const api = env.VITE_SUPABASE_URL!;
const headers = { apikey: env.VITE_SUPABASE_ANON_KEY!, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
const ORDER = 'ord-00593';
const PROPOSAL = 'agent-x6ad46f8e74398f5e';

async function clearLive(request: APIRequestContext) {
  const live = await request.get(`${api}/rest/v1/decisions?target_id=eq.${PROPOSAL}&undone_at=is.null&select=id`, { headers });
  for (const d of (await live.json()) as { id: string }[]) {
    await request.post(`${api}/rest/v1/rpc/undo_decision`, { headers, data: { p_id: d.id } });
  }
}

test.beforeEach(async ({ request }) => clearLive(request));
test.afterAll(async ({ request }) => clearLive(request));

test('approve the empty-pickup proposal, see it decided, then undo it', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('a[data-row]').first()).toBeVisible();
  const row = page.getByRole('link', { name: /CD-420593/ });
  await expect(row).toContainText('Driver found no car at pickup');

  await row.click();
  await expect(page).toHaveURL(/\/orders\/CD-420593$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BMW M4');
  const lead = page.getByRole('article');
  await expect(lead.getByRole('heading', { name: 'Needs human confirmation' })).toBeVisible();

  // Before saving: the numbered outcome, with the customer step left to a person.
  await lead.getByRole('button', { name: 'Approve' }).click();
  const outcome = lead.getByRole('list', { name: 'What will happen' });
  await expect(outcome.getByRole('listitem').first()).toContainText('re-checks the order before acting');
  await expect(outcome).toContainText('Draft for the customer');
  await expect(outcome).toContainText('On you.');

  await lead.getByRole('button', { name: 'Save: Approve' }).click();
  await expect(lead).toContainText('Decided by you');
  await expect(lead.getByRole('list', { name: 'What happens' })).toContainText('re-checks the order before acting');

  // A second decision on the same item is refused by the database.
  const second = await request.post(`${api}/rest/v1/rpc/decide`, {
    headers, data: { p_order_id: ORDER, p_target_id: PROPOSAL, p_action: 'reject', p_note: 'second try' },
  });
  expect(second.status()).toBe(409);
  expect(((await second.json()) as { message: string }).message).toMatch(/Already decided/);

  // Decided, the order leaves Needs action; undo on the order page brings the decision back.
  await page.getByRole('link', { name: /Needs action/ }).first().click();
  await expect(page.getByRole('link', { name: /CD-420593/ })).toHaveCount(0);
  await page.goto('/orders/CD-420593');
  await page.getByRole('article').getByRole('button', { name: /Undo/ }).click();
  await expect(page.getByRole('article').getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('the queue works from the keyboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[data-row]').first()).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.locator('a[data-row]').first()).toBeFocused();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(page.locator('a[data-row]').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/orders\/CD-420593$/);
});

test('a decision made elsewhere takes the order off Needs action without a reload, and its undo brings it back', async ({ page, request }) => {
  await page.goto('/');
  const row = page.getByRole('link', { name: /CD-420593/ });
  await expect(row).toBeVisible();

  // Someone else, in another browser, approves the proposal.
  const made = await request.post(`${api}/rest/v1/rpc/decide`, {
    headers, data: { p_order_id: ORDER, p_target_id: PROPOSAL, p_action: 'approve' },
  });
  expect(made.ok()).toBe(true);
  await expect(row).toHaveCount(0, { timeout: 15000 });

  // And undoes it.
  await request.post(`${api}/rest/v1/rpc/undo_decision`, { headers, data: { p_id: ((await made.json()) as { id: string }).id } });
  await expect(page.getByRole('link', { name: /CD-420593/ })).toBeVisible({ timeout: 15000 });
});
