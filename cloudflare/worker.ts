import { DurableObject } from 'cloudflare:workers';

// Shapes follow the documented Artifacts Workers binding.
// `npx wrangler types` generates the exact ones for your account.
interface RepoHandle extends Disposable {
  info(): Promise<{ name: string; remote: string; defaultBranch?: string }>;
  fork(name: string, opts: { defaultBranchOnly: boolean; description?: string }): Promise<CreateResult>;
  createToken(scope: 'read' | 'write', ttl: number): Promise<{ plaintext: string; expiresAt: string }>;
}
interface CreateResult {
  name: string;
  remote: string;
  token: string;
}
interface Env {
  ARTIFACTS: {
    create(name: string, opts: { setDefaultBranch: string; description?: string }): Promise<CreateResult>;
    get(name: string): Promise<RepoHandle>;
    delete(name: string): Promise<boolean>;
  };
  FEROX_REGISTRY: DurableObjectNamespace<Registry>;
  RUNNER_SECRET: string;
  VIEWER_SECRET?: string;
  RUNNER_URL?: string;
  RUNNER_API_SECRET?: string;
  ASSETS: Fetcher;
}

const TOKEN_TTL_SECONDS = 900;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const validName = (name: unknown): name is string => typeof name === 'string' && NAME.test(name);

// Artifacts tokens come back as art_v1_<secret>?expires=<unix>. Git wants just the secret.
const gitSecret = (token: string) => token.split('?expires=')[0];

// constant-time compare so the bearer check doesn't leak timing
function sameSecret(given: string | null, expected: string | undefined) {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Which repos this bridge made, and what they were forked from. Never stores tokens. */
export class Registry extends DurableObject<Env> {
  async register(name: string, source: string | null) {
    const existing = await this.ctx.storage.get<{ source: string | null }>(name);
    if (existing && existing.source !== source) throw new Error('name already registered to a different source');
    if (!existing) await this.ctx.storage.put(name, { source, createdAt: Date.now() });
  }
  async lookup(name: string) {
    return (await this.ctx.storage.get<{ source: string | null; createdAt: number }>(name)) ?? null;
  }
  async forget(name: string) {
    await this.ctx.storage.delete(name);
  }
}

// create and fork can return before the repo is usable. get() throws until it's ready.
async function waitReady(env: Env, name: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  for (;;) {
    try {
      using repo = await env.ARTIFACTS.get(name);
      return await repo.info();
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`repo ${name} not ready after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

async function writeCredential(env: Env, name: string) {
  using repo = await env.ARTIFACTS.get(name);
  const token = await repo.createToken('write', TOKEN_TTL_SECONDS);
  const info = await repo.info();
  return { name: info.name, remote: info.remote, token: gitSecret(token.plaintext), expiresAt: token.expiresAt };
}

async function exists(env: Env, name: string) {
  try {
    using repo = await env.ARTIFACTS.get(name);
    await repo.info();
    return true;
  } catch {
    return false;
  }
}

async function bridge(request: Request, env: Env, path: string) {
  const registry = env.FEROX_REGISTRY.get(env.FEROX_REGISTRY.idFromName('ferox'));
  const raw = await request.text();
  if (raw.length > 8192) return reply({ error: 'too large' }, 413);
  const body = JSON.parse(raw);
  if (!validName(body.name) || !body.name.startsWith('ferox-')) return reply({ error: 'bad repo name' }, 400);

  if (path === '/bridge/trunk') {
    // idempotent: a retry after a lost response gets the same repo back
    const known = await registry.lookup(body.name);
    if (!known) {
      try {
        await env.ARTIFACTS.create(body.name, { setDefaultBranch: 'main', description: 'ferox trunk' });
      } catch (error) {
        if (!(await exists(env, body.name))) throw error;
      }
      await registry.register(body.name, null);
    } else if (known.source !== null) {
      return reply({ error: 'that name is a fork, not a trunk' }, 409);
    }
    await waitReady(env, body.name);
    return reply(await writeCredential(env, body.name), 201);
  }

  if (path === '/bridge/fork') {
    if (!validName(body.source) || !(await registry.lookup(body.source))) return reply({ error: 'unknown source' }, 403);
    const known = await registry.lookup(body.name);
    if (known && known.source !== body.source) return reply({ error: 'name taken by another source' }, 409);
    if (!known) {
      try {
        using source = await env.ARTIFACTS.get(body.source);
        await source.fork(body.name, { defaultBranchOnly: true, description: `ferox attempt from ${body.source}` });
      } catch (error) {
        if (!(await exists(env, body.name))) throw error;
      }
      await registry.register(body.name, body.source);
    }
    await waitReady(env, body.name);
    return reply(await writeCredential(env, body.name), 201);
  }

  if (path === '/bridge/token') {
    if (!(await registry.lookup(body.name))) return reply({ error: 'unknown repo' }, 403);
    if (body.scope !== 'read' && body.scope !== 'write') return reply({ error: 'bad scope' }, 400);
    using repo = await env.ARTIFACTS.get(body.name);
    const token = await repo.createToken(body.scope, TOKEN_TTL_SECONDS);
    const info = await repo.info();
    return reply({ name: info.name, remote: info.remote, token: gitSecret(token.plaintext), expiresAt: token.expiresAt });
  }

  if (path === '/bridge/delete') {
    if (!(await registry.lookup(body.name))) return reply({ error: 'unknown repo' }, 403);
    await env.ARTIFACTS.delete(body.name);
    await registry.forget(body.name);
    return reply({ deleted: body.name });
  }

  return reply({ error: 'unknown route' }, 404);
}

// optional: put the dashboard on the Worker and proxy its API to the runner
async function proxy(request: Request, env: Env, url: URL) {
  if (!env.RUNNER_URL || !env.RUNNER_API_SECRET || !env.VIEWER_SECRET) {
    return reply({ error: 'runner proxy not configured. set RUNNER_URL, RUNNER_API_SECRET and VIEWER_SECRET.' }, 503);
  }
  if (!sameSecret(request.headers.get('Authorization'), `Bearer ${env.VIEWER_SECRET}`)) {
    return reply({ error: 'dashboard token required' }, 401);
  }
  const allowed = new Set(['GET /api/state', 'GET /api/health', 'GET /api/runs/summary', 'POST /api/runs', 'POST /api/run']);
  if (!allowed.has(`${request.method} ${url.pathname}`)) return reply({ error: 'route not allowed' }, 404);

  const upstream = new URL(env.RUNNER_URL);
  if (upstream.protocol !== 'https:') return reply({ error: 'RUNNER_URL must be https' }, 503);
  upstream.pathname = url.pathname;
  upstream.search = '';
  const body = request.method === 'POST' ? await request.text() : undefined;
  if (body && body.length > 16384) return reply({ error: 'too large' }, 413);
  try {
    return await fetch(upstream, {
      method: request.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RUNNER_API_SECRET}` },
      body,
      redirect: 'error',
    });
  } catch {
    return reply({ error: 'runner unreachable' }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return proxy(request, env, url);
    if (url.pathname === '/health') return reply({ ok: true, artifacts: typeof env.ARTIFACTS?.get === 'function' });
    if (!url.pathname.startsWith('/bridge/')) return env.ASSETS.fetch(request);

    if (!sameSecret(request.headers.get('Authorization'), `Bearer ${env.RUNNER_SECRET}`)) {
      return reply({ error: 'runner token required' }, 401);
    }
    if (request.method !== 'POST') return reply({ error: 'use POST' }, 405);
    try {
      return await bridge(request, env, url.pathname);
    } catch (error) {
      // platform errors can echo request details. log them, don't return them.
      console.error('bridge error', url.pathname, error instanceof Error ? error.message : String(error));
      return reply({ error: 'Artifacts call failed. check `wrangler tail`.' }, 502);
    }
  },
};
