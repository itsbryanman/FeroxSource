// End-to-end check against real Cloudflare Artifacts.
//   npm run cloud:smoke            (reads .env.cloud)
//
// 1. runs the rename vs. caller scenario with Artifacts as the backend
// 2. clones the Artifacts trunk fresh and checks main + notes match the local ledger
// 3. tries to push to trunk with a fork's write token. that has to fail.
// 4. writes what it saw to evidence/cloud-smoke.json
import path from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.mjs';
import { bridgeFromEnv } from '../src/config.mjs';
import { id, redactCloudflareGitOutput } from '../src/util.mjs';

const bridge = bridgeFromEnv();
if (!bridge) throw new Error('set FEROX_BRIDGE_URL and FEROX_BRIDGE_TOKEN (npm run cloud:smoke loads .env.cloud)');

const root = path.resolve(`.ferox/${id('cloud-smoke')}`);
const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, ok, detail = {}) => {
  report.steps.push({ name, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.note ? `  (${detail.note})` : ''}`);
  if (!ok) process.exitCode = 1;
};

const t0 = Date.now();
const engine = await new Engine(root, { remote: bridge }).init();
const trunk = engine.state.externalRepo;
step('created Artifacts trunk and pushed seed', !!trunk, { note: trunk?.name });

await engine.generate('semantic', 2);
await engine.run();
const caller = engine.state.changes.find((c) => c.id === 'new-caller');
step('rename vs. caller resolved in cloud mode', engine.state.metrics.accepted === 4 && caller.replayCount === 1, {
  note: `landed ${engine.state.metrics.accepted}, replays ${engine.state.metrics.replays}`,
});
const forks = engine.state.changes.flatMap((c) => c.attempts.map((a) => a.externalRepo?.name)).filter(Boolean);
step('every attempt got its own Artifacts fork', forks.length === engine.state.changes.reduce((n, c) => n + c.attempts.length, 0), {
  note: `${forks.length} forks`,
});

// fresh clone with a read token, compare against the ledger
const read = await bridge.token(trunk.name, 'read');
const clone = await mkdtemp(path.join(tmpdir(), 'ferox-clone-'));
await bridge.authenticatedGit(engine.git, clone, ['clone', read.remote, clone], read.token);
await bridge.authenticatedGit(engine.git, clone, ['fetch', 'origin', 'refs/notes/ferox:refs/notes/ferox'], read.token);
const clonedHead = (await engine.git.git(['rev-parse', 'HEAD'], clone)).output.trim();
step('fresh clone of Artifacts main equals local ledger head', clonedHead === engine.state.head, { note: clonedHead.slice(0, 12) });
const note = (await engine.git.git(['notes', '--ref=ferox', 'show', 'HEAD'], clone, { allowFailure: true })).output;
step('intent notes travel with the Artifacts repo', note.includes('"intents"'), { note: note.slice(0, 80) });

// token boundary: a fork's write token must not be able to move trunk
const forkName = forks[0];
const forkToken = await bridge.token(forkName, 'write');
const attack = await bridge.authenticatedGit(
  engine.git,
  engine.git.remote,
  ['push', trunk.remote, `${engine.state.initialHead}:refs/heads/main`, '--force'],
  forkToken.token,
  { allowFailure: true },
);
const after = await bridge.token(trunk.name, 'read');
const trunkHead = await bridge.remoteHead(engine.git, trunk, after.token);
step('fork token cannot push to trunk', attack.code !== 0 && trunkHead === engine.state.head, {
  note: `git exit ${attack.code}`,
  output: redactCloudflareGitOutput(attack.output).slice(-600),
});

report.trunk = trunk.name; // remote URLs carry the account id, leave them out
report.forks = forks;
report.totalMs = Date.now() - t0;
report.metrics = engine.state.metrics;
await mkdir('evidence', { recursive: true });
await writeFile('evidence/cloud-smoke.json', JSON.stringify(report, null, 2));
console.log(`\n${report.totalMs} ms. report: evidence/cloud-smoke.json. run data: ${root}`);
console.log(`clean up later with: npm run cloud:cleanup -- ${root}`);
