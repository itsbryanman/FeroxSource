import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const id = (prefix) => `${prefix}-${randomUUID().slice(0, 12)}`;

export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

export const copy = (value) => structuredClone(value);

export const redactCloudflareGitOutput = (value) =>
  value
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/https:\/\/[^/\s]+\.artifacts\.cloudflare\.net/g, 'https://[redacted].artifacts.cloudflare.net');

// write-then-rename so a crash never leaves half a state file
export async function atomicJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, file);
}

export async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function files(root, prefix = '') {
  const out = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(root, rel)));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`refusing non-regular file: ${rel}`);
  }
  return out.sort();
}

/**
 * Spawn a process with a clean env (PATH + LANG + whatever you pass), a hard
 * timeout that kills the whole process group, and a cap on captured output.
 */
export function run(command, args, { cwd, timeout = 30_000, env = {}, allowFailure = false, limit = 128_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let overflow = false;

    const kill = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);

    const collect = (chunk) => {
      output += chunk;
      if (output.length > limit) {
        overflow = true;
        output = output.slice(0, limit);
        kill();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, output, timedOut, overflow };
      if (!allowFailure && (code !== 0 || timedOut || overflow)) {
        reject(new Error(`${command} failed (${code}): ${output.slice(-3000)}`));
      } else {
        resolve(result);
      }
    });
  });
}

// run fn over items with at most `width` in flight. keeps result order.
export async function pooled(items, width, fn) {
  let next = 0;
  const output = new Array(items.length);
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      output[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return output;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
