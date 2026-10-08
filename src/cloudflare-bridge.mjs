// Runner side of the Cloudflare bridge. The Worker creates and forks Artifacts
// repos and mints short-lived repo-scoped tokens. All code moves over plain git.

export class CloudflareBridge {
  constructor(url, token) {
    if (!url || !token) throw new Error('set FEROX_BRIDGE_URL and FEROX_BRIDGE_TOKEN');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error('bridge URL must be https');
    }
    this.url = url.replace(/\/$/, '');
    this.secret = token;
  }

  async request(route, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(this.url + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      if (attempt < 8 && [429, 500, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        continue;
      }
      throw new Error(`bridge ${route} failed (${response.status}): ${data.error ?? 'no detail'}`);
    }
  }

  // token goes in through the child env, never argv, the remote URL, git config on disk, or output
  authenticatedGit(git, repo, args, token, options = {}) {
    return git.git(args, repo, {
      ...options,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      },
    });
  }

  async createTrunk(git, head) {
    const name = `ferox-${crypto.randomUUID().slice(0, 12)}`;
    const created = await this.request('/bridge/trunk', { name });
    await this.authenticatedGit(git, git.remote, ['push', created.remote, `${head}:refs/heads/main`], created.token);
    return { name: created.name, remote: created.remote };
  }

  async forkAndPush(git, repo, head, trunk, name) {
    const fork = await this.request('/bridge/fork', { source: trunk.name, name: `${trunk.name}-${name}` });
    await this.authenticatedGit(git, repo, ['push', '--force', fork.remote, `${head}:refs/heads/main`], fork.token);
    // fetch it back so cloud mode proves the round trip, not just the push
    await this.authenticatedGit(git, git.remote, ['fetch', fork.remote, `+refs/heads/main:refs/proposals/cloud/${name}`], fork.token);
    const fetched = (await git.git(['rev-parse', `refs/proposals/cloud/${name}`])).output.trim();
    if (fetched !== head) throw new Error(`Artifacts round trip mismatch for ${name}`);
    return { name: fork.name, remote: fork.remote };
  }

  async remoteHead(git, trunk, token) {
    const out = await this.authenticatedGit(git, git.remote, ['ls-remote', trunk.remote, 'refs/heads/main'], token);
    return out.output.trim().split(/\s/)[0] || null;
  }

  async publish(git, trunk, expected, head) {
    const { token } = await this.request('/bridge/token', { name: trunk.name, scope: 'write' });
    const current = await this.remoteHead(git, trunk, token);
    if (current === head) return; // already pushed before a crash; finish locally
    if (current !== expected) throw new Error('Artifacts trunk diverged from the ledger. stopping.');
    await this.authenticatedGit(
      git,
      git.remote,
      ['push', `--force-with-lease=refs/heads/main:${expected}`, trunk.remote, `${head}:refs/heads/main`],
      token,
    );
    if ((await this.remoteHead(git, trunk, token)) !== head) throw new Error('Artifacts publish did not stick');
  }

  async syncNotes(git, trunk) {
    const { token } = await this.request('/bridge/token', { name: trunk.name, scope: 'write' });
    await this.authenticatedGit(git, git.remote, ['push', '--force', trunk.remote, 'refs/notes/ferox:refs/notes/ferox'], token);
  }

  token(name, scope) {
    return this.request('/bridge/token', { name, scope });
  }

  delete(name) {
    return this.request('/bridge/delete', { name });
  }
}
