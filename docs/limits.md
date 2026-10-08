# Limits

What this is and isn't, said once.

- **One trunk, one integrator.** Every landing goes through one serialized publisher and one oracle run per batch. Throughput is roughly batch size over oracle time. Sharding trunks by package is the next step and isn't built.
- **Footprints are syntax, not semantics.** Top-level TypeScript symbols, name-based, through imports. Dynamic calls, reflection, config files and anything not TypeScript are invisible to them. The oracle catches those after the fact, which costs a failing set and a replay instead of a skipped batch.
- **The oracle is only as good as its checks.** Passing means the strict typecheck, the project invariants and every landed acceptance check passed. Not that the code is right.
- **Failing-set reduction is bounded.** It stops after 12 extra oracle runs, so a reported set can be bigger than the smallest one.
- **Most agents are codemods.** They make real commits and real conflicts and replay for real, but they're deterministic. Real coding agents plug in through `src/agents.mjs` and are used where no codemod exists. Every attempt is labeled with which kind made it.
- **Agent sandboxing is light.** Claude Code runs with file tools only and no shell, in a throwaway workspace, and anything it writes outside `src/**/*.ts` gets quarantined. It isn't a container. For untrusted agents, run the runner in a container or VM.
- **State is a JSON file per run.** Writes are atomic and publication recovers after a crash between the ref update and the ledger. A crash mid-oracle-run needs the run restarted.
- **Demo project is small.** Five real modules plus fixtures for the conflict scenarios. Big repos would move assembly and the oracle onto more machines.
- **Scale I've actually run** is in `docs/benchmarks.md`. I'm not claiming anything past that.
