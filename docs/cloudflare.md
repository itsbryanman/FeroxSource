# Running on Cloudflare

## What runs where

| piece | where | does |
| --- | --- | --- |
| bridge Worker (`cloudflare/worker.ts`) | Cloudflare Workers | creates the trunk repo, forks one repo per attempt, mints 15-minute repo-scoped tokens, deletes repos on cleanup, serves the dashboard |
| Registry Durable Object | Cloudflare | remembers which repos the bridge made and what each was forked from. No tokens stored. |
| trunk + attempt repos | Cloudflare Artifacts | all code, every attempt, `main`, `refs/notes/ferox` |
| runner (`src/`) | your Linux box | agents, analyzer, oracle, integration loop |

The runner can't run the oracle inside a Worker (Workers don't exec a TypeScript compiler and test runner), so it runs on a box with Node and Git. Everything it builds moves through Artifacts over plain git.

## Set it up

Needs the Workers Paid plan with Artifacts turned on.

```bash
npm ci
npm run cloud:setup     # wrangler login if needed, deploy, set RUNNER_SECRET, write .env.cloud
npm run cloud:smoke     # end to end check, writes evidence/cloud-smoke.json
```

`cloud:smoke` does six checks against real Artifacts:

1. creates a trunk and pushes the seed project
2. runs rename vs. caller in cloud mode, the caller replays, everything lands
3. every attempt got its own Artifacts fork
4. a fresh clone of the Artifacts trunk matches the local ledger
5. the intent notes came along in that clone
6. a fork's write token can't push to trunk

Then:

```bash
npm run start:cloud     # dashboard on 127.0.0.1:8788, backed by Artifacts
npm run demo:cloud -- semantic 24
npm run benchmark:cloud -- 24 3
npm run cloud:cleanup -- .ferox/<run dir>   # delete the repos a run made
```

## Notes

- Tokens go to git through `http.extraHeader` in the child env. Never in argv, the remote URL, a config file on disk, or logs.
- `create` and `fork` are idempotent by name. If the response gets lost, a retry gets the same repo back instead of a second one.
- The Worker waits until a new repo answers `get()` before handing out a token.
- Publishing to Artifacts `main` uses `--force-with-lease` against the expected parent and reads it back after. If Artifacts `main` isn't what the ledger expects, the run stops.
- Before I ran it on my account I tested the same runner code against `test/fixtures/stand-in-bridge.mjs`, a local stand-in with the same routes over real git smart HTTP and per-repo tokens. That test is in the suite. It is not Cloudflare.
- Artifacts limits that matter here: 2,000 git requests per 10 s per repo, 2,000 control-plane calls per 10 s per namespace, 1 GB per repo.

## Hosted dashboard (optional)

The Worker serves the dashboard too. To make its API work it proxies to the runner. Set `RUNNER_URL` (https, behind a tunnel), `RUNNER_API_SECRET` (the runner's `FEROX_API_TOKEN`) and `VIEWER_SECRET`, then redeploy. Click "API token" in the dashboard and paste `VIEWER_SECRET`.
