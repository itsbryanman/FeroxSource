// Test stand-in for the Cloudflare bridge Worker + Artifacts. Not Cloudflare.
// Same HTTP routes as cloudflare/worker.ts, backed by local bare repos served
// over real git smart HTTP (git http-backend) with per-repo scoped tokens.
// Lets the test suite run the actual runner + smoke script code paths.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function startStandInBridge({ secret = 'test-secret' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ferox-bridge-'));
  const repos = new Map(); // name -> { source }
  const tokens = new Map(); // token -> { name, scope }
  const backend = path.join(execFileSync('git', ['--exec-path']).toString().trim(), 'git-http-backend');
  let base;

  const mint = (name, scope) => {
    const token = `art_v1_${randomBytes(16).toString('hex')}`;
    tokens.set(token, { name, scope });
    return token;
  };
  const credential = (name, scope = 'write') => ({ name, remote: `${base}/git/${name}.git`, token: mint(name, scope) });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith('/bridge/')) {
      if (req.headers.authorization !== `Bearer ${secret}`) return json(401, { error: 'runner token required' });
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/bridge/trunk') {
        if (!repos.has(body.name)) {
          git('init', '--bare', '--initial-branch=main', `${body.name}.git`);
          repos.set(body.name, { source: null });
        }
        return json(201, credential(body.name));
      }
      if (url.pathname === '/bridge/fork') {
        if (!repos.has(body.source)) return json(403, { error: 'unknown source' });
        if (!repos.has(body.name)) {
          git('clone', '--bare', '--single-branch', `${body.source}.git`, `${body.name}.git`);
          repos.set(body.name, { source: body.source });
        }
        return json(201, credential(body.name));
      }
      if (url.pathname === '/bridge/token') {
        if (!repos.has(body.name)) return json(403, { error: 'unknown repo' });
        return json(200, credential(body.name, body.scope));
      }
      if (url.pathname === '/bridge/delete') {
        repos.delete(body.name);
        return json(200, { deleted: body.name });
      }
      return json(404, { error: 'unknown route' });
    }

    const match = /^\/git\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (!match || !repos.has(match[1])) return json(404, { error: 'no repo' });
    const [, name, rest] = match;
    const grant = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    const writing = url.searchParams.get('service') === 'git-receive-pack' || rest.endsWith('git-receive-pack');
    if (!grant || grant.name !== name || (writing && grant.scope !== 'write')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('token not valid for this repository\n');
    }

    const cgi = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'agent',
        REQUEST_METHOD: req.method,
        PATH_INFO: `/${name}.git${rest}`,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        PATH: process.env.PATH,
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0),
      sent = false;
    cgi.stdout.on('data', (chunk) => {
      if (sent) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf('\r\n\r\n');
      if (split < 0) return;
      const headers = {};
      let status = 200;
      for (const line of head.subarray(0, split).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        const value = v.join(':').trim();
        if (k.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[k] = value;
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(split + 4));
    });
    cgi.on('close', () => res.end());
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: base, secret, root, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}
