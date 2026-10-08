# How it works

## The problem

Git merges text. It flags two edits to the same lines and nothing else. Give 200 agents one repo and the merges that hurt are the ones Git calls clean: agent A renames `parseDate`, agent B adds a new call to `parseDate` in a different file. No overlapping lines, clean merge, broken build.

A merge queue catches that at test time, then hands the conflict back to whoever pushed second. With agents, that author is usually a process that already exited. It gets conflict markers and no idea why the other change happened.

## The idea

A change here is an intent plus a cached diff:

- **intent**: the task text, its acceptance checks, and who it came from. Immutable once claimed.
- **attempt**: one diff, built by an agent against one specific trunk commit.

The diff is a cache of the intent at that commit. When trunk moves under something the change depends on, the cache is stale. Ferox throws the diff away and has an agent rebuild the change from the intent against the new trunk, and tells it which change landed and why. No conflict markers.

## The loop

1. **Claim.** Each intent gets its own workspace forked from trunk. On Cloudflare that's an Artifacts fork with a write token scoped to that fork only.
2. **Draft.** An agent makes the change and commits. Codemod agents run in-process. Real coding agents (Claude Code by default) run in the workspace with file tools only and no shell.
3. **Analyze.** The TypeScript analyzer diffs before and after and records a footprint: which top-level symbols the change writes, which of those it *breaks* (removed, or signature changed), and which it reads. Name-based, through imports, no type checker. A body-only edit to a typed function writes it but doesn't break it, so its callers don't go stale over it. If the type is inferred, any edit counts as a break.
4. **Stale check.** If something that landed since the attempt's base breaks a symbol this attempt reads, or writes a symbol this attempt also writes, the attempt is stale. Stale attempts replay before they ever get tested.
5. **Batch.** Oldest first, skip anything that interacts with what's already in the batch, cap at 16.
6. **Assemble + oracle.** Cherry-pick the batch onto trunk and run the full oracle: strict typecheck of the whole tree, fixed project invariants, and every acceptance check of every change that has ever landed.
7. **Land.** Green: compare-and-set `main` to the candidate commit and attach a git note with every member's intent and attempt lineage. Red: reduce the batch to a failing set, block one member, land the rest, replay the blocked one later.
8. **Replay.** The agent gets the original task, the landed changes that touched its footprint (fenced as data), and the failing set if there was one. Two replays max, then it escalates to a human.

Footprints decide what to batch and what to replay. They never decide what lands. The oracle does. A wrong footprint costs a replay or an extra oracle run, never a broken trunk.

## Conflict classes

| class | caught by | what happens |
| --- | --- | --- |
| disjoint | footprints don't touch | batched together, one oracle run |
| read-write (rename vs. new caller) | footprint, before testing | reader goes stale, replays against the new name |
| write-write | footprint | later one replays on top of the first |
| behavioral (two budgets that only overflow together) | oracle only | batch reduced to the failing set, one member blocked and replayed, escalates if it can't fit |
| protected path (agent edits the oracle policy) | path policy, before testing | quarantined |

## Order doesn't matter

Rename first: the rename lands, the caller is stale, the caller replays and calls `decodeDate`.

Caller first: the caller lands, the rename is stale because it writes what the caller now reads, the rename replays against the new trunk and renames the new call site too.

Both orders are tests (`test/core.test.mjs`).

## Real agents

`src/agents.mjs` has two kinds:

- `codemod`: deterministic, handles every task with a known spec. This is what runs at scale.
- `command`: any CLI coding agent. The prompt goes in on stdin, the agent edits files in the workspace, the engine commits what it left and analyzes that. The agent never sees a git token. Default is stock Claude Code:

```
claude -p --permission-mode acceptEdits \
  --allowedTools "Read Edit Write Glob Grep" --disallowedTools "Bash WebFetch WebSearch" \
  --output-format json --no-session-persistence --max-budget-usd 0.5
```

The `llm` workload has a task no codemod can do (`daysBetween` in `src/range.ts`). With `FEROX_AGENT=claude` set, Claude writes it against `parseDate`, the rename lands, the attempt goes stale, and Claude rebuilds it against `decodeDate` with the rename's intent in its prompt. Transcripts are saved per attempt.

## Why still Git

Agents already know Git. Every workspace is a real repo any agent can clone. Trunk is a plain repo you can clone and read with `git log --notes=ferox`. Artifacts gives one cheap repo per attempt. I didn't need a new storage model. I needed a different unit of work on top of it.
