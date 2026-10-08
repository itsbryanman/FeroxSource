// Drives the dashboard through the video beats in a visible browser window.
// Used by scripts/record-demo.sh. PACE=1.5 slows every pause by 1.5x.
import { chromium } from 'playwright-core';

const url = process.env.FEROX_URL || 'http://127.0.0.1:8788';
const pace = Number(process.env.PACE || 1);
const withAgent = process.env.WITH_AGENT === '1';
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000 * pace));

async function humanClick(locator) {
  const box = await locator.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    await wait(0.25);
  }
  await locator.click();
}

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  args: ['--start-fullscreen', '--window-position=0,0', '--window-size=1920,1080', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: null });
await page.goto(url);

async function run(workload, mode, count, { inspect } = {}) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.mouse.move(300, 190, { steps: 16 });
  await page.selectOption('#workload', workload);
  await wait(0.35);
  await page.mouse.move(520, 190, { steps: 14 });
  await page.selectOption('#mode', mode);
  const countInput = page.locator('#count');
  await humanClick(countInput);
  await countInput.press('ControlOrMeta+A');
  await countInput.pressSequentially(String(count), { delay: 90 });
  await wait(1.5);
  await humanClick(page.locator('#prepare'));
  await page.waitForFunction(() => /drafted/.test(document.querySelector('#status').textContent), null, { timeout: 600_000 });
  await page.locator('#graph').scrollIntoViewIfNeeded();
  await wait(4);
  await humanClick(page.locator('#integrate'));
  await page.waitForFunction(() => /^done|^stopped/.test(document.querySelector('#status').textContent), null, { timeout: 900_000 });
  await wait(2);
  if (inspect) await inspect();
}

// beat 1: baseline on the rename vs. caller workload
await wait(4);
await run('semantic', 'baseline', 24, {
  inspect: async () => {
    const red = page.locator('#candidates .outcome.failed').first();
    if (await red.count()) {
      await humanClick(red);
      await wait(6);
    }
  },
});

// beat 2: same workload, ferox
await run('semantic', 'ferox', 24, {
  inspect: async () => {
    await humanClick(page.locator('#graph g[aria-label^="Add date report"]').first());
    await page.locator('aside').scrollIntoViewIfNeeded();
    await wait(10);
  },
});

// beat 3: caller first
await run('semantic-reversed', 'ferox', 24, {
  inspect: async () => {
    await humanClick(page.locator('#graph g[aria-label^="Rename date parser"]').first());
    await wait(8);
  },
});

// beat 4: two changes that only fail together
await run('pair', 'ferox', 24, {
  inspect: async () => {
    const hub = page.locator('#graph g[aria-label^="failing set"]').first();
    if (await hub.count()) {
      await humanClick(hub);
      await wait(8);
    }
  },
});

// beat 5: agent edits the oracle policy
await run('policy', 'ferox', 8, { inspect: () => wait(5) });

// beat 6: real coding agent
if (withAgent) {
  await run('llm', 'ferox', 8, {
    inspect: async () => {
      await humanClick(page.locator('#graph g[aria-label^="Add daysBetween"]').first());
      await wait(12);
    },
  });
}

// beat 7: runs table
await page.locator('.runs-panel').scrollIntoViewIfNeeded();
await wait(10);
await browser.close();
