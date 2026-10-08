// Browser QA: starts the server, runs a scenario through the UI, screenshots
// desktop + phone widths, fails on console errors or horizontal overflow.
//   npm run ui:check            (CHROME_PATH=... to point at a Chrome binary)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = 8790 + Math.floor(Math.random() * 100);
const data = await mkdtemp(path.join(tmpdir(), 'ferox-ui-'));
const server = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, PORT: String(port), FEROX_DATA: data }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1200));

const out = path.resolve(process.argv[2] || 'docs/img');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const problems = [];

try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: name === 'phone' ? 2 : 1 });
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`${name} page error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.selectOption('#workload', 'semantic');
    await page.fill('#count', '10');
    await page.click('#prepare');
    await page.waitForFunction(() => /drafted/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
    await page.screenshot({ path: path.join(out, `${name}-ready.png`), fullPage: true });
    await page.click('#integrate');
    await page.waitForFunction(() => /^done/.test(document.querySelector('#status').textContent), null, { timeout: 120_000 });
    await page.waitForTimeout(800);
    const node = page.locator('#graph g[role=button]').first();
    if (await node.count()) await node.click();
    await page.screenshot({ path: path.join(out, `${name}-done.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${name}: page scrolls sideways by ${overflow}px`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'ui check clean');
console.log(`screenshots in ${out}`);
process.exitCode = problems.length ? 1 : 0;
