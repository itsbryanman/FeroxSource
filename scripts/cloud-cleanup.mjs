// Delete every Artifacts repo a run created.  npm run cloud:cleanup -- .ferox/<run>
import path from 'node:path';
import { readJSON } from '../src/util.mjs';
import { bridgeFromEnv } from '../src/config.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: npm run cloud:cleanup -- <run directory>');
const bridge = bridgeFromEnv();
if (!bridge) throw new Error('set FEROX_BRIDGE_URL and FEROX_BRIDGE_TOKEN');

const state = await readJSON(path.join(dir, 'state.json'));
const names = state.changes.flatMap((c) => c.attempts.map((a) => a.externalRepo?.name)).filter(Boolean);
if (state.externalRepo) names.push(state.externalRepo.name);

for (const name of names) {
  try {
    await bridge.delete(name);
    console.log(`deleted ${name}`);
  } catch (error) {
    console.log(`skip ${name}: ${error.message}`);
  }
}
