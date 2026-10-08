// npm run demo -- <workload> [extra independent tasks] [baseline]
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { WORKLOADS } from '../src/workloads.mjs';
import { bridgeFromEnv, agentFromEnv } from '../src/config.mjs';
import { id } from '../src/util.mjs';

const name = process.argv[2] || 'semantic';
const count = Number(process.argv[3] ?? 12);
const mode = process.argv[4] === 'baseline' ? 'baseline' : 'ferox';
if (!WORKLOADS.includes(name)) throw new Error(`workload must be one of: ${WORKLOADS.join(', ')}`);

const root = path.resolve(process.env.FEROX_DATA || `.ferox/${id(name)}`);
const remote = bridgeFromEnv();
const agent = agentFromEnv();
const engine = await new Engine(root, { mode, remote, agent }).init();

const shown = ['change.analyzed', 'trunk.advanced', 'intent.invalidated', 'conflict.observed', 'change.escalated', 'policy.quarantined', 'agent.failed'];
engine.on('event', (e) => {
  if (!shown.includes(e.type)) return;
  const who = e.changeId ? ` ${e.changeId}` : '';
  const extra = e.type === 'trunk.advanced' ? ` ${e.commit.slice(0, 10)} [${e.members.join(', ')}]`
    : e.type === 'change.analyzed' ? ` attempt ${e.attempt} by ${e.agent}`
    : e.type === 'intent.invalidated' ? ` because ${e.context.interactingIntents.map((x) => x.id).join(', ') || e.context.reason}`
    : e.reason ? ` (${e.reason})` : e.message ? ` (${e.message})` : '';
  console.log(`${e.type}${who}${extra}`);
});

console.log(`ferox ${mode} | ${name} +${count} | backend ${remote ? 'artifacts' : 'local git'} | agent ${agent?.name ?? 'codemod only'}`);
await engine.generate(name, count);
await engine.run();

const m = engine.state.metrics;
console.log(`\nlanded ${m.accepted}, replays ${m.replays}, validations ${m.validations}, agent runs ${m.agentRuns}`);
console.log(`trunk: ${engine.git.remote}`);
if (engine.state.externalRepo) console.log(`artifacts trunk: ${engine.state.externalRepo.remote}`);
console.log(`state and evidence: ${root}`);
