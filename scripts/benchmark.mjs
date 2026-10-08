// Ferox vs. merge-queue baseline on the same workloads, same oracle, same agents.
//   npm run benchmark -- [extra agents=24] [repeats=3]
// Uses Artifacts if FEROX_BRIDGE_URL is set (npm run benchmark:cloud).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../src/engine.mjs';
import { bridgeFromEnv, agentFromEnv } from '../src/config.mjs';
import { id } from '../src/util.mjs';

const count = Number(process.argv[2] ?? 24);
const repeats = Number(process.argv[3] ?? 3);
if (!Number.isInteger(count) || count < 0 || count > 256) throw new Error('extra agents must be 0-256');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1-10');

const workloads = (process.env.FEROX_BENCH_WORKLOADS || 'independent,semantic,semantic-reversed,pair,triple,policy,alternatives').split(',');
const remote = bridgeFromEnv();
const agent = agentFromEnv();
const out = path.resolve(process.env.FEROX_BENCHMARK_OUTPUT || 'benchmarks');
await mkdir(out, { recursive: true });

const rows = [];
for (const workload of workloads) {
  for (let rep = 0; rep < repeats; rep++) {
    // alternate which mode goes first so warm caches don't favor one side
    for (const mode of rep % 2 ? ['baseline', 'ferox'] : ['ferox', 'baseline']) {
      const engine = await new Engine(path.join(out, 'runs', id(`${workload}-${mode}`)), { mode, remote, agent }).init();
      const t0 = Date.now();
      await engine.generate(workload, count, 8);
      const t1 = Date.now();
      await engine.run();
      const s = engine.state;
      const latencies = s.changes
        .filter((c) => c.state === 'accepted')
        .map((c) => c.acceptedAt - c.submittedAt)
        .sort((a, b) => a - b);
      const pct = (p) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
      const row = {
        workload,
        mode,
        rep,
        backend: remote ? 'artifacts' : 'local',
        changes: s.changes.length,
        llmAgentRuns: s.metrics.agentRuns,
        accepted: s.metrics.accepted,
        escalated: s.changes.filter((c) => c.state === 'escalated').length,
        quarantined: s.changes.filter((c) => c.state === 'quarantined').length,
        deferred: s.changes.filter((c) => c.state === 'deferred').length,
        replays: s.metrics.replays,
        oracleRuns: s.metrics.validations,
        failingSets: s.capsules.length,
        oracleMs: s.metrics.validationMs,
        draftMs: t1 - t0,
        integrateMs: Date.now() - t1,
        p50LandMs: pct(0.5),
        p95LandMs: pct(0.95),
        landedPerMin: +((s.metrics.accepted * 60000) / (Date.now() - t1)).toFixed(1),
        runDir: path.relative(out, engine.root),
      };
      rows.push(row);
      console.log(`${workload.padEnd(18)} ${mode.padEnd(8)} rep ${rep}  landed ${row.accepted}/${row.changes}  oracle ${row.oracleRuns}  replays ${row.replays}  ${row.integrateMs} ms`);
    }
  }
}

const env = { node: process.version, platform: os.platform(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model };
await writeFile(path.join(out, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), env, count, repeats, rows }, null, 2));

// medians per workload x mode
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) / 2)];
};
const lines = [
  `| workload | mode | landed | escalated | oracle runs | failing sets | replays | integrate (ms) |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
];
for (const workload of workloads) {
  for (const mode of ['ferox', 'baseline']) {
    const r = rows.filter((x) => x.workload === workload && x.mode === mode);
    lines.push(
      `| ${workload} | ${mode} | ${median(r.map((x) => x.accepted))}/${r[0].changes} | ${median(r.map((x) => x.escalated))} | ${median(r.map((x) => x.oracleRuns))} | ${median(r.map((x) => x.failingSets))} | ${median(r.map((x) => x.replays))} | ${median(r.map((x) => x.integrateMs))} |`,
    );
  }
}
const md = `Medians of ${repeats} runs, ${count} extra agents per workload, ${remote ? 'Artifacts' : 'local git'} backend, ${env.cpu} (${env.cpus} cpus), node ${env.node}.\n\n${lines.join('\n')}\n`;
await writeFile(path.join(out, 'results.md'), md);
console.log(`\n${md}`);
