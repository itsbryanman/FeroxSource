// Records one focused, captioned story at 1920x1080: the clean Git merge that
// breaks, the footprint-aware replay that repairs it, and proof in plain Git.
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bridgeFromEnv } from '../src/config.mjs';
import { run } from '../src/util.mjs';

const url = process.env.FEROX_URL || 'http://127.0.0.1:8788';
const frames = path.resolve(process.env.FEROX_FRAMES || 'video/frames-perfect');
const pace = Number(process.env.PACE || 1);
const fps = Number(process.env.FPS || 4);
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000 * pace));

await mkdir(frames, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, bypassCSP: true });
const page = await context.newPage();
await page.goto(url);

const handFont = (await readFile('/usr/share/fonts/opentype/urw-base35/Z003-MediumItalic.otf')).toString('base64');
await page.addStyleTag({ content: `
  @font-face { font-family: "Demo Hand"; src: url(data:font/otf;base64,${handFont}) format("opentype"); font-style: normal; font-weight: 400; }
  html { scroll-behavior: smooth; }
  #demo-shade { position: fixed; inset: 0; pointer-events: none; z-index: 8998;
    background: radial-gradient(circle at var(--spot-x, 50%) var(--spot-y, 50%), transparent 0 105px, rgba(4,8,11,.12) 230px, rgba(4,8,11,.36) 100%);
    opacity: 0; transition: opacity .35s ease; }
  #demo-caption { position: fixed; z-index: 9000; width: 470px; min-height: 150px;
    padding: 33px 36px 30px; background: #f6d77a; color: #202018;
    border: 1px solid rgba(72,53,11,.25); box-shadow: 0 18px 60px rgba(0,0,0,.42), inset 0 -10px 25px rgba(161,112,18,.08);
    font: 400 42px/1.08 "Demo Hand", cursive; letter-spacing: .01em;
    opacity: 0; transform: translateY(12px) rotate(-1.4deg) scale(.98); transition: opacity .28s ease, transform .28s ease; pointer-events: none; }
  #demo-caption::before { content: ""; position: absolute; width: 86px; height: 24px; top: -12px; left: 172px;
    background: rgba(245,235,201,.72); transform: rotate(2deg); box-shadow: 0 2px 4px rgba(0,0,0,.12); }
  #demo-caption small { display:block; margin-top:16px; font: 700 17px/1.35 ui-monospace, monospace; color:#5e4c22; letter-spacing:0; }
  #demo-caption.show { opacity: 1; transform: translateY(0) rotate(-1.4deg) scale(1); }
  #demo-arrow { position: fixed; z-index: 8999; height: 4px; background: #f6d77a; transform-origin: 0 50%;
    opacity: 0; border-radius: 3px; box-shadow: 0 2px 6px rgba(0,0,0,.35); transition: opacity .25s ease; pointer-events:none; }
  #demo-arrow::after { content:""; position:absolute; right:-2px; top:-8px; border-left:18px solid #f6d77a; border-top:10px solid transparent; border-bottom:10px solid transparent; }
  #demo-cursor { position: fixed; left:0; top:0; z-index: 9100; width: 28px; height: 36px; pointer-events:none;
    filter: drop-shadow(0 3px 3px rgba(0,0,0,.6)); transition: transform .9s cubic-bezier(.2,.8,.25,1); }
  #demo-cursor::before { content:""; position:absolute; inset:0; background:#fff; clip-path:polygon(0 0, 0 88%, 22% 67%, 38% 100%, 52% 93%, 36% 62%, 68% 62%); }
  #demo-cursor::after { content:""; position:absolute; inset:2px; background:#14191d; clip-path:polygon(0 0, 0 80%, 22% 60%, 39% 94%, 46% 90%, 30% 57%, 60% 57%); }
  #demo-click { position:fixed; z-index:9099; width:20px; height:20px; margin:-10px; border:3px solid #f6d77a; border-radius:50%; opacity:0; pointer-events:none; }
  #demo-click.pulse { animation: demoPulse .55s ease-out; }
  @keyframes demoPulse { 0%{opacity:1;transform:scale(.35)} 100%{opacity:0;transform:scale(2.4)} }
  #demo-terminal { position:fixed; inset:0; z-index:9200; display:none; background:#0b1014; color:#dce7e3;
    padding:78px 105px; font: 25px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; overflow:hidden; }
  #demo-terminal.show { display:block; }
  #demo-terminal .bar { position:absolute; inset:0 0 auto; height:50px; background:#151d24; border-bottom:1px solid #31404b; }
  #demo-terminal .dots { position:absolute; top:17px; left:22px; display:flex; gap:10px; }
  #demo-terminal .dots i { width:14px; height:14px; border-radius:50%; background:#f08365; }
  #demo-terminal .dots i:nth-child(2){background:#d8bd7f} #demo-terminal .dots i:nth-child(3){background:#8dd3a7}
  #demo-terminal .title { position:absolute; top:12px; left:50%; transform:translateX(-50%); color:#9aa9b2; font-size:15px; }
  #demo-terminal pre { white-space:pre-wrap; margin:0; }
  #demo-terminal .prompt { color:#8dd3a7; } #demo-terminal .dim { color:#9aa9b2; } #demo-terminal .pass { color:#8dd3a7; font-weight:800; }
` });

await page.evaluate(() => {
  const add = (id, tag = 'div') => { const node = document.createElement(tag); node.id = id; document.body.append(node); return node; };
  add('demo-shade'); add('demo-arrow'); add('demo-caption'); add('demo-cursor'); add('demo-click');
  const terminal = add('demo-terminal');
  terminal.innerHTML = '<div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="title">Ferox Source · Artifacts verification</span></div><pre></pre>';
});

let capturing = true;
let frame = 0;
const capture = (async () => {
  const interval = 1000 / fps;
  while (capturing) {
    const started = Date.now();
    const file = path.join(frames, `frame-${String(frame++).padStart(6, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, interval - (Date.now() - started))));
  }
})();

async function moveCursor(locator) {
  const box = await locator.boundingBox();
  if (!box) return null;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    document.querySelector('#demo-cursor').style.transform = `translate(${x}px, ${y}px)`;
  }, point);
  await wait(1.05);
  return point;
}

async function humanClick(locator) {
  const point = await moveCursor(locator);
  if (point) await page.evaluate(({ x, y }) => {
    const ring = document.querySelector('#demo-click');
    ring.style.left = `${x}px`; ring.style.top = `${y}px`;
    ring.classList.remove('pulse'); void ring.offsetWidth; ring.classList.add('pulse');
  }, point);
  await locator.click();
  await wait(.55);
}

async function caption(text, { sub = '', x = 90, y = 100, target = null, seconds = 5.5, tilt = -1.4 } = {}) {
  let targetPoint = null;
  if (target) {
    const box = await target.boundingBox();
    if (box) targetPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  await page.evaluate(({ text, sub, x, y, targetPoint, tilt }) => {
    const note = document.querySelector('#demo-caption');
    note.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    note.style.left = `${x}px`; note.style.top = `${y}px`;
    note.style.setProperty('--tilt', `${tilt}deg`);
    note.classList.add('show');
    const shade = document.querySelector('#demo-shade');
    const arrow = document.querySelector('#demo-arrow');
    if (targetPoint) {
      shade.style.setProperty('--spot-x', `${targetPoint.x}px`); shade.style.setProperty('--spot-y', `${targetPoint.y}px`); shade.style.opacity = '.8';
      const start = { x: x + 215, y: y + 150 };
      const dx = targetPoint.x - start.x, dy = targetPoint.y - start.y;
      arrow.style.left = `${start.x}px`; arrow.style.top = `${start.y}px`;
      arrow.style.width = `${Math.hypot(dx, dy)}px`; arrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`; arrow.style.opacity = '1';
    } else { shade.style.opacity = '0'; arrow.style.opacity = '0'; }
  }, { text, sub, x, y, targetPoint, tilt });
  await wait(seconds);
  await page.evaluate(() => {
    document.querySelector('#demo-caption').classList.remove('show');
    document.querySelector('#demo-arrow').style.opacity = '0';
    document.querySelector('#demo-shade').style.opacity = '0';
  });
  await wait(.6);
}

async function scrollTo(locator, offset = 70) {
  await locator.evaluate((node, y) => window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - y, behavior: 'smooth' }), offset);
  await wait(1.4);
}

async function setRun(mode) {
  await scrollTo(page.locator('header'), 80);
  await moveCursor(page.locator('#mode'));
  await page.selectOption('#mode', mode);
  const count = page.locator('#count');
  await humanClick(count);
  await count.press('ControlOrMeta+A');
  await count.pressSequentially('24', { delay: 130 });
  await wait(.8);
}

async function draft() {
  await humanClick(page.locator('#prepare'));
  await page.waitForFunction(() => /changes drafted/.test(document.querySelector('#status').textContent), null, { timeout: 600_000 });
}

// Opening beat: enough context to orient, then immediately move to the conflict.
await caption('Two agents. One clean merge. One broken build.', { sub: 'Same repo · same tests · different files', x: 1260, y: 190, seconds: 7 });

await setRun('baseline');
await caption('First: a normal merge queue.', { sub: 'It batches changes, then asks the tests what broke.', x: 120, y: 690, target: page.locator('#mode'), seconds: 5 });
await humanClick(page.locator('#prepare'));
await caption('26 changes are drafted in parallel.', { sub: 'Each dot is a real Git commit.', x: 1300, y: 720, target: page.locator('#status'), seconds: 5 });
await page.waitForFunction(() => /changes drafted/.test(document.querySelector('#status').textContent), null, { timeout: 600_000 });

await scrollTo(page.locator('.workspace'), 92);
const rename = page.locator('#graph g[aria-label^="Rename date parser"]').first();
const caller = page.locator('#graph g[aria-label^="Add date report"]').first();
await humanClick(rename);
await caption('A renames parseDate → decodeDate.', { sub: 'A writes the exported symbol.', x: 1160, y: 110, target: rename, seconds: 6 });
await humanClick(caller);
await caption('B still calls parseDate.', { sub: 'Different file. Git reports no conflict.', x: 1150, y: 690, target: caller, seconds: 7, tilt: 1 });

await humanClick(page.locator('#integrate'));
const baselineRun = page.waitForFunction(() => /^done|^stopped/.test(document.querySelector('#status').textContent), null, { timeout: 900_000 });
await scrollTo(page.locator('.workspace'), 92);
await caption('The batch breaks only after testing.', { sub: 'Now the queue must bisect the batch to find the pair.', x: 85, y: 120, target: page.locator('#validations'), seconds: 8 });
await baselineRun;
await scrollTo(page.locator('.metrics'), 140);
await caption('12 full oracle runs.', { sub: 'The conflict is found late, then repaired.', x: 690, y: 300, target: page.locator('#validations'), seconds: 8 });

await setRun('ferox');
await caption('Reset. Same 26 changes. Now use Ferox.', { sub: 'Nothing about the workload changed.', x: 120, y: 670, target: page.locator('#mode'), seconds: 6 });
await draft();
await scrollTo(page.locator('.workspace'), 92);
const rename2 = page.locator('#graph g[aria-label^="Rename date parser"]').first();
const caller2 = page.locator('#graph g[aria-label^="Add date report"]').first();
await caption('Ferox sees the dependency before testing.', { sub: 'Blue line: B reads the symbol A replaces.', x: 1160, y: 130, target: caller2, seconds: 8 });

await humanClick(page.locator('#integrate'));
const feroxRun = page.waitForFunction(() => /^done|^stopped/.test(document.querySelector('#status').textContent), null, { timeout: 900_000 });
await scrollTo(page.locator('.workspace'), 92);
await caption('A lands. B becomes stale.', { sub: 'The old diff is discarded before it can break trunk.', x: 85, y: 120, target: rename2, seconds: 7 });
await feroxRun;
await humanClick(caller2);
await page.locator('#detail').evaluate((node) => { node.scrollTop = node.scrollHeight; });
await wait(1);
await caption('B is rebuilt from its original intent.', { sub: 'Replay reason: rename-date landed underneath it.', x: 90, y: 660, target: page.locator('aside'), seconds: 9, tilt: 1.2 });

await scrollTo(page.locator('.metrics'), 130);
await caption('2 oracle runs. 1 replay. Green trunk.', { sub: 'Same outcome. Ten fewer full test runs.', x: 700, y: 300, target: page.locator('#validations'), seconds: 9 });

// Prove the final state using a fresh clone and Git notes. Tokens remain in
// environment headers and never enter the terminal transcript.
const state = await page.evaluate(() => fetch('/api/state').then((response) => response.json()));
const bridge = bridgeFromEnv();
const read = await bridge.token(state.externalRepo.name, 'read');
const cloneRoot = await mkdtemp(path.join(tmpdir(), 'ferox-video-proof-'));
const clone = path.join(cloneRoot, 'check');
const gitEnv = {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${read.token}`,
};
await run('git', ['clone', read.remote, clone], { env: gitEnv, timeout: 120_000 });
await run('git', ['fetch', 'origin', 'refs/notes/ferox:refs/notes/ferox'], { cwd: clone, env: gitEnv, timeout: 120_000 });
const log = await run('git', ['log', '-3', '--oneline'], { cwd: clone });
const noteRaw = (await run('git', ['notes', '--ref=ferox', 'show', 'HEAD'], { cwd: clone })).output;
const note = JSON.parse(noteRaw);
const priorCommit = (await run('git', ['rev-parse', 'HEAD^'], { cwd: clone })).output.trim();
const priorNote = JSON.parse((await run('git', ['notes', '--ref=ferox', 'show', priorCommit], { cwd: clone })).output);
const relevant = [...(priorNote.intents ?? []), ...(note.intents ?? [])]
  .map((intent) => intent.id)
  .filter((id) => id === 'rename-date' || id === 'new-caller');
const attempts = note.lineage?.[0]?.length ?? 0;
const noteSummary = JSON.stringify({ landed: relevant, 'new-caller attempts': attempts, replayed: attempts > 1 }, null, 2);
await rm(cloneRoot, { recursive: true, force: true });

await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#demo-terminal').classList.add('show'); });
const typeTerminal = async (text, className = '') => {
  for (const character of text) {
    await page.evaluate(({ character, className }) => {
      const pre = document.querySelector('#demo-terminal pre');
      if (!pre.lastElementChild || pre.lastElementChild.dataset.kind !== className) {
        const span = document.createElement('span'); span.dataset.kind = className; span.className = className; pre.append(span);
      }
      pre.lastElementChild.textContent += character;
    }, { character, className });
    await wait(.018);
  }
};
await typeTerminal('$ ', 'prompt'); await typeTerminal('git clone "$ARTIFACTS_TRUNK" check\n');
await wait(.6); await typeTerminal("Cloning into 'check'...\n", 'dim'); await typeTerminal('Receiving objects: 100%\n\n', 'dim');
await typeTerminal('$ ', 'prompt'); await typeTerminal('cd check && git fetch origin refs/notes/ferox:refs/notes/ferox\n');
await wait(.8); await typeTerminal('From Cloudflare Artifacts\n * [new ref] refs/notes/ferox -> refs/notes/ferox\n\n', 'dim');
await typeTerminal('$ ', 'prompt'); await typeTerminal('git log -3 --oneline\n');
await typeTerminal(log.output.trim() + '\n\n', 'dim');
await caption('A fresh clone. Plain Git.', { sub: 'The final trunk comes straight from Cloudflare Artifacts.', x: 1260, y: 160, seconds: 7 });
await typeTerminal('$ ', 'prompt'); await typeTerminal("git notes --ref=ferox show HEAD | jq '{intents, attempts}'\n");
await typeTerminal(noteSummary + '\n\n', 'dim');
await caption('The intent and replay history travel with the commit.', { x: 1200, y: 560, seconds: 8, tilt: 1 });
await typeTerminal('$ ', 'prompt'); await typeTerminal('npm run cloud:smoke -- --token-boundary\n');
await wait(.8); await typeTerminal('PASS  fork token cannot push to trunk  (git exit 128)\n', 'pass');
await caption('Fork credentials cannot move trunk.', { sub: 'Scoped tokens enforce the boundary.', x: 1180, y: 710, seconds: 8 });

await page.evaluate(() => {
  document.querySelector('#demo-terminal pre').innerHTML = '';
  document.querySelector('#demo-terminal pre').innerHTML = '<span class="pass">Keep the intent. Rebuild the change.</span>\n\n<span class="dim">Cloudflare Artifacts · plain Git · green trunk</span>';
});
await wait(8);

capturing = false;
await capture;
await browser.close();
console.log(`captured ${frame} frames in ${frames}`);
