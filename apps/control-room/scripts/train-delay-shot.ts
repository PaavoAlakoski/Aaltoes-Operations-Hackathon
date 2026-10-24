// Signs in as a dispatcher and screenshots the train-delay order page at desktop and phone width.
// Needs `npm run dev` and DEMO_PASSWORD (root .env): tsx --env-file=../../.env scripts/train-delay-shot.ts <out dir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const out = resolve(process.argv[2] ?? 'screens');
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('DEMO_PASSWORD is not set');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
for (const [width, height] of [[1440, 1000], [390, 844]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(base + '/');
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.getByLabel('Email').fill('mira.kestelund@demo.bahn.test');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await page.getByText('Incidents', { exact: true }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, `needs-you-${width}.png`) });
  await page.goto(base + '/orders/CD-421024');
  await page.getByLabel('Is the driver in time for the pickup').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`${width}px overflow: ${overflow}`);
  await page.screenshot({ path: join(out, `train-delay-${width}.png`), fullPage: true });
  await page.close();
}
await browser.close();
