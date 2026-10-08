// Local dashboard + API. Binds to loopback unless FEROX_API_TOKEN is set.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { WORKLOADS } from './workloads.mjs';
import { bridgeFromEnv, agentFromEnv } from './config.mjs';
import { id, atomicJSON } from './util.mjs';

const root = path.resolve(process.env.FEROX_DATA || '.ferox');
const web = fileURLToPath(new URL('../web/', import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8788);
const secret = process.env.FEROX_API_TOKEN;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !secret) {
  throw new Error('binding off loopback needs FEROX_API_TOKEN');
}

const remote = bridgeFromEnv();
const agent = agentFromEnv();
await mkdir(root, { recursive: true });

const engines = new Map(); // runs created by this process, in order
let active = null;
let creating = false;

function track(runId, engine) {
  engines.set(runId, engine);
  active = engine;
}

async function create(name = 'semantic', count = 16, mode = 'ferox') {
  if (creating || active?.running) throw new Error('a run is busy. wait for it to finish.');
  if (!WORKLOADS.includes(name)) throw new Error('unknown workload');
  if (!Number.isInteger(count) || count < 0 || count > 256) throw new Error('count must be 0-256');
  if (!['ferox', 'baseline'].includes(mode)) throw new Error('mode must be ferox or baseline');
  creating = true;
  try {
    const runId = id('run');
    const engine = await new Engine(path.join(root, runId), { mode, remote, agent }).init();
    track(runId, engine);
    await engine.generate(name, count);
    await atomicJSON(path.join(root, 'active.json'), { runId });
    return engine;
  } finally {
    creating = false;
  }
}

// pick up the last run after a restart
try {
  const { runId } = JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8'));
  if (!/^run-[a-f0-9-]+$/.test(runId)) throw new Error('bad run id in active.json');
  track(runId, await new Engine(path.join(root, runId), { remote, agent }).init());
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function summary() {
  return [...engines.values()].map((e) => {
    const s = e.state;
    return {
      workload: s.workload ?? '?',
      mode: s.mode,
      backend: s.externalRepo ? 'artifacts' : 'local',
      changes: s.changes.length,
      accepted: s.metrics.accepted,
      replays: s.metrics.replays,
      validations: s.metrics.validations,
      capsules: s.capsules.length,
      escalated: s.changes.filter((c) => c.state === 'escalated').length,
      integrationSec: s.integrationMs ? +(s.integrationMs / 1000).toFixed(1) : null,
    };
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) throw new Error('request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return send(res, 403, { error: 'cross-origin request denied' });
  }
  if (url.pathname.startsWith('/api/') && secret && req.headers.authorization !== `Bearer ${secret}`) {
    return send(res, 401, { error: 'auth required' });
  }

  try {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') return send(res, 200, active?.view() || { empty: true });
    if (route === 'GET /api/runs/summary') return send(res, 200, summary());
    if (route === 'GET /api/health') {
      return send(res, 200, { ok: true, backend: remote ? 'artifacts' : 'local-git', agent: agent?.name ?? null });
    }
    if (route === 'POST /api/runs') {
      const input = await readBody(req);
      const engine = await create(input.workload, input.count, input.mode);
      return send(res, 201, engine.view());
    }
    if (route === 'POST /api/run') {
      if (!active || active.running || active.generating) throw new Error('no run ready yet, or one is still busy');
      const engine = active;
      engine.run().catch((error) => engine.event('run.error', { message: error.message }));
      return send(res, 202, { started: true });
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = STATIC[url.pathname];
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
      return res.end(await readFile(path.join(web, file)));
    }
    send(res, 404, { error: 'not found' });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(
    `ferox: http://${host}:${port}  backend: ${remote ? 'artifacts' : 'local git'}  agent: ${agent?.name ?? 'codemod only'}`,
  );
});
