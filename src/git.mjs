import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, files } from './util.mjs';

// fixed identity and no user/system config, so runs are reproducible and
// nothing from the host leaks into commits
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Ferox',
  GIT_AUTHOR_EMAIL: 'ferox@localhost',
  GIT_COMMITTER_NAME: 'Ferox',
  GIT_COMMITTER_EMAIL: 'ferox@localhost',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

const SAFE_PATH = /^[a-zA-Z0-9_./-]+$/;
const MAX_FILE_BYTES = 256_000;

export class GitStore {
  constructor(root) {
    this.root = root;
    this.remote = path.join(root, 'trunk.git');
  }

  git(args, cwd = this.remote, options = {}) {
    return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      ...options,
      env: { ...GIT_ENV, ...options.env },
    });
  }

  async init(snapshot) {
    await mkdir(this.root, { recursive: true });
    await this.git(['init', '--bare', '--initial-branch=main', this.remote], this.root);
    const seed = path.join(this.root, 'seed');
    await mkdir(seed, { recursive: true });
    await this.git(['init', '--initial-branch=main'], seed);
    await this.write(seed, snapshot);
    await this.git(['add', '.'], seed);
    await this.git(['commit', '-m', 'Seed project'], seed);
    await this.git(['push', this.remote, 'HEAD:refs/heads/main'], seed);
    return this.head();
  }

  async head() {
    return (await this.git(['rev-parse', 'refs/heads/main'])).output.trim();
  }

  async snapshot(sha) {
    const listing = await this.git(['ls-tree', '-r', '--name-only', sha]);
    const out = {};
    for (const file of listing.output.trim().split('\n').filter(Boolean)) {
      out[file] = (await this.git(['show', `${sha}:${file}`])).output;
    }
    return out;
  }

  async write(repo, changes) {
    for (const [file, text] of Object.entries(changes)) {
      checkPath(file);
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), text);
    }
  }

  // read what an external agent left in the working tree
  async readWorktree(repo) {
    const out = {};
    for (const file of await files(repo)) {
      checkPath(file);
      const text = await readFile(path.join(repo, file), 'utf8');
      if (text.length > MAX_FILE_BYTES) throw new Error(`agent wrote an oversized file: ${file}`);
      out[file] = text;
    }
    return out;
  }

  async fork(base, name) {
    const repo = path.join(this.root, 'workspaces', name);
    await mkdir(path.dirname(repo), { recursive: true });
    await this.git(['clone', '--no-hardlinks', this.remote, repo], this.root);
    await this.git(['checkout', '--detach', base], repo);
    return repo;
  }

  async commit(repo, changes, title) {
    await this.write(repo, changes);
    return this.commitWorktree(repo, title);
  }

  // commits everything in the tree, deletions included
  async commitWorktree(repo, title) {
    await this.git(['add', '-A'], repo);
    await this.git(['commit', '--allow-empty', '-m', title], repo);
    return (await this.git(['rev-parse', 'HEAD'], repo)).output.trim();
  }

  async import(repo, sha, ref) {
    if (!/^[0-9a-f]{40}$/.test(sha) || !/^[a-zA-Z0-9_/-]+$/.test(ref)) throw new Error('bad git identity');
    await this.git(['fetch', repo, `${sha}:refs/proposals/${ref}`]);
  }

  // cherry-pick each attempt onto base. a textual conflict stops assembly.
  async assemble(base, attempts, name) {
    const repo = await this.fork(base, name);
    for (const attempt of attempts) {
      const result = await this.git(['cherry-pick', '--no-commit', attempt.head], repo, { allowFailure: true });
      if (result.code !== 0) return { repo, ok: false, kind: 'textual', output: result.output, at: attempt.changeId };
    }
    await this.git(['commit', '--allow-empty', '-m', `Candidate ${name}`], repo);
    const sha = (await this.git(['rev-parse', 'HEAD'], repo)).output.trim();
    const tree = (await this.git(['rev-parse', 'HEAD^{tree}'], repo)).output.trim();
    await this.import(repo, sha, `candidates/${name}`);
    return { repo, ok: true, sha, tree };
  }

  async publish(expected, sha, note) {
    // update-ref with an old value is compare-and-set
    await this.git(['update-ref', 'refs/heads/main', sha, expected]);
    await this.ensureNote(sha, note);
  }

  async ensureNote(sha, note) {
    await this.git(['notes', '--ref=ferox', 'add', '-f', '-m', JSON.stringify(note), sha]);
  }

  async validate(repo, checks, runDirectory) {
    await mkdir(runDirectory, { recursive: true });
    const spec = path.join(runDirectory, 'checks.json');
    await writeFile(spec, JSON.stringify(checks));
    const oracle = fileURLToPath(new URL('./oracle.mjs', import.meta.url));
    return run(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', oracle], {
      cwd: repo,
      env: { FEROX_REPO: repo, FEROX_CHECKS: spec },
      allowFailure: true,
      timeout: 30_000,
    });
  }
}

function checkPath(file) {
  if (!SAFE_PATH.test(file) || file.split('/').includes('..') || file.startsWith('/') || file.startsWith('.git')) {
    throw new Error(`bad workspace path: ${file}`);
  }
}
