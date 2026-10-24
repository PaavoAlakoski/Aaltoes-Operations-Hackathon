// Walks the screens and orders named in the brief at 1440 px and 390 px,
// saves a screenshot of each, and reports any horizontal overflow.
// Needs `npm run dev` running. Uses the installed Chrome, else Playwright's Chromium.
import { chromium, type Browser } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const out = resolve(process.argv[2] ?? 'screens');
// --top: capture only the first screen, to read the details.
const fullPage = !process.argv.includes('--top');
mkdirSync(out, { recursive: true });

const pages: [string, string][] = [
  ['needs-you', '/'],
  ['orders', '/orders'],
  ['inbox', '/inbox'],
  ['agents', '/agents'],
  ['CD-420299-ferry', '/orders/CD-420299'],
  ['CD-420593-empty-pickup', '/orders/CD-420593'],
  ['CD-420322-breakdown', '/orders/CD-420322'],
  ['CD-420702-promise', '/orders/CD-420702'],
  ['CD-420455-condition', '/orders/CD-420455'],
  ['CD-420384-keys', '/orders/CD-420384'],
  ['CD-420075-quiet', '/orders/CD-420075'],
  ['missing', '/orders/CD-999999'],
];

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return chromium.launch();
  }
}

const browser = await launch();
let problems = 0;
for (const [width, height] of [[1440, 1000], [390, 844]] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const [name, path] of pages) {
    await page.goto(base + path);
    await page.waitForSelector('[role="status"]', { state: 'detached', timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) {
      problems++;
      console.log(`overflow ${overflow}px: ${name} at ${width}`);
    }
    await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage });
  }
  await page.close();
}
await browser.close();
console.log(problems ? `${problems} page(s) overflow.` : `No horizontal overflow. Screenshots in ${out}`);
process.exit(problems ? 1 : 0);
