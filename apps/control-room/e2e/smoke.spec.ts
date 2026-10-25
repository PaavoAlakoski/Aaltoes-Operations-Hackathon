// The main flow, end to end against the real database: open the queue, open
// CD-420593, approve the agent's proposal, see the numbered outcome, find it
// in "Decided this shift", check a second decision is refused, undo it.
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
  await expect(lead.getByRole('heading', { name: 'Operations copilot needs your yes' })).toBeVisible();

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

  // It shows under "Decided this shift", and undo puts it back in the queue.
  await page.getByRole('link', { name: /Needs action/ }).first().click();
  const shift = page.getByRole('region', { name: /Decided this shift/ });
  await expect(shift).toContainText('CD-420593');
  await expect(shift).toContainText('Approve');
  await shift.getByRole('button', { name: /Undo Approve on CD-420593/ }).click();
  // The section disappears once nothing is decided, so check the row is gone.
  await expect(shift.getByText('CD-420593')).toHaveCount(0);

  await page.goto('/orders/CD-420593');
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
  await expect(page).toHaveURL(/\/orders\/CD-420322$/);
});

test('a decision made elsewhere appears without a reload, and so does its undo', async ({ page, request }) => {
  const target = 'work-x2174da059fcd89e8'; // CD-420516 key holder check
  const leftovers = await request.get(`${api}/rest/v1/decisions?target_id=eq.${target}&undone_at=is.null&select=id`, { headers });
  for (const d of (await leftovers.json()) as { id: string }[]) {
    await request.post(`${api}/rest/v1/rpc/undo_decision`, { headers, data: { p_id: d.id } });
  }

  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  const shift = page.getByRole('region', { name: /Decided this shift/ });
  await expect(shift.getByText('CD-420516')).toHaveCount(0);

  // Someone else, in another browser, takes the item.
  const made = await request.post(`${api}/rest/v1/rpc/decide`, {
    headers, data: { p_order_id: 'ord-00516', p_target_id: target, p_action: 'take' },
  });
  expect(made.ok()).toBe(true);
  await expect(shift).toContainText('CD-420516');

  // And undoes it.
  await request.post(`${api}/rest/v1/rpc/undo_decision`, { headers, data: { p_id: ((await made.json()) as { id: string }).id } });
  await expect(shift.getByText('CD-420516')).toHaveCount(0);
});
