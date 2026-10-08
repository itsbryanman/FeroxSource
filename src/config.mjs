// Runner settings from env. One place so server, demo and benchmark agree.
import { CloudflareBridge } from './cloudflare-bridge.mjs';
import { commandAgent, CLAUDE_ARGS } from './agents.mjs';

export function bridgeFromEnv() {
  if (!process.env.FEROX_BRIDGE_URL) return null;
  return new CloudflareBridge(process.env.FEROX_BRIDGE_URL, process.env.FEROX_BRIDGE_TOKEN);
}

// FEROX_AGENT=claude          stock Claude Code (claude -p), file tools only
// FEROX_AGENT=command         FEROX_AGENT_CMD + FEROX_AGENT_ARGS (json array), prompt on stdin
export function agentFromEnv() {
  const kind = process.env.FEROX_AGENT;
  if (!kind) return null;
  const common = {
    timeoutMs: Number(process.env.FEROX_AGENT_TIMEOUT_MS || 300_000),
    parallel: Number(process.env.FEROX_AGENT_PARALLEL || 2),
    maxBudgetUsd: process.env.FEROX_AGENT_MAX_USD ? Number(process.env.FEROX_AGENT_MAX_USD) : 0.5,
  };
  if (kind === 'claude') {
    const args = process.env.FEROX_AGENT_MODEL ? [...CLAUDE_ARGS, '--model', process.env.FEROX_AGENT_MODEL] : CLAUDE_ARGS;
    return commandAgent({ name: 'claude', command: process.env.FEROX_CLAUDE_BIN || 'claude', args, ...common });
  }
  if (kind === 'command') {
    if (!process.env.FEROX_AGENT_CMD) throw new Error('FEROX_AGENT=command needs FEROX_AGENT_CMD');
    return commandAgent({
      name: process.env.FEROX_AGENT_NAME || 'command',
      command: process.env.FEROX_AGENT_CMD,
      args: JSON.parse(process.env.FEROX_AGENT_ARGS || '[]'),
      maxBudgetUsd: null,
      ...common,
    });
  }
  throw new Error(`unknown FEROX_AGENT: ${kind}`);
}
