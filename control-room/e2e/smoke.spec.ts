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
  await expect(page.getByRole('heading', { name: 'Decide now' })).toBeVisible();
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
  await page.getByRole('link', { name: /Needs you/ }).first().click();
  const shift = page.getByRole('region', { name: /Decided this shift/ });
  await expect(shift).toContainText('CD-420593');
  await expect(shift).toContainText('Approve');
  await shift.getByRole('button', { name: /Undo Approve on CD-420593/ }).click();
  await expect(shift).not.toContainText('CD-420593');

  await page.goto('/orders/CD-420593');
  await expect(page.getByRole('article').getByRole('button', { name: 'Approve' })).toBeVisible();
});
