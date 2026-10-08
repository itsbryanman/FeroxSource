# Benchmarks

Same workloads, same codemod agents, same oracle, same batch cap (16), same reduction budget. The only difference is the integrator:

- **ferox**: footprint-aware batching, stale check, replay from intent.
- **baseline**: a merge queue. Batch oldest-first, test, bisect failures down to a failing set, block one member, retry it later from its task. That is already better than what most merge queues do with a conflict (send it back to the author).

Reproduce with `npm run benchmark -- 24 3`. Raw rows are in `benchmarks/results.json`, the run directories are kept locally under `benchmarks/runs/`.

## Results

Medians of 3 runs, 24 extra agents per workload, local git backend, Intel(R) Xeon(R) Processor @ 2.10GHz (2 cpus), node v22.22.0.

| workload | mode | landed | escalated | oracle runs | failing sets | replays | integrate (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| independent | ferox | 24/24 | 0 | 2 | 0 | 0 | 3090 |
| independent | baseline | 24/24 | 0 | 2 | 0 | 0 | 3135 |
| semantic | ferox | 26/26 | 0 | 2 | 0 | 1 | 4594 |
| semantic | baseline | 26/26 | 0 | 12 | 1 | 1 | 38557 |
| semantic-reversed | ferox | 26/26 | 0 | 2 | 0 | 1 | 4833 |
| semantic-reversed | baseline | 26/26 | 0 | 12 | 1 | 1 | 25723 |
| pair | ferox | 25/26 | 1 | 13 | 3 | 2 | 27723 |
| pair | baseline | 25/26 | 1 | 13 | 3 | 2 | 27805 |
| triple | ferox | 26/27 | 1 | 17 | 3 | 2 | 34805 |
| triple | baseline | 26/27 | 1 | 17 | 3 | 2 | 34714 |
| policy | ferox | 24/25 | 0 | 2 | 0 | 0 | 6922 |
| policy | baseline | 24/25 | 0 | 2 | 0 | 0 | 7208 |
| alternatives | ferox | 25/26 | 0 | 4 | 0 | 0 | 12835 |
| alternatives | baseline | 25/26 | 0 | 4 | 0 | 0 | 11708 |

## What it says

- **Rename vs. caller (either order):** Ferox lands everything in 2 oracle runs. The merge queue tests the broken combo, then spends 10 more runs bisecting it before it can retry the caller. About 8x faster on the same box.
- **Independent work:** a tie. The footprint check doesn't cost anything you can see.
- **Pair and triple (behavioral conflicts):** a tie. These changes touch different files and share no symbols, so footprints can't see them. Both integrators find them through the oracle the same way. This is the honest limit of syntax-level footprints.
- **Alternatives:** Ferox is a little slower here. It previews each competing alternative on its own first so the loser has evidence too. Both land one.
- **Policy:** both quarantine the tampering change before it's tested.
- Trunk was never red in either mode. Both test before landing. The difference is how much testing it takes and who has to fix it.

## Cloud and scale runs

Local numbers above. Artifacts numbers come from `npm run benchmark:cloud -- 24 3` and get added here once I've run them on my account.
