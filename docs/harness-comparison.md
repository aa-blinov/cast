# cast vs mcode

The behaviour bench ([evals/](https://github.com/aa-blinov/cast/tree/master/evals)) measures cast
against contracts cast defines. This measures the question a person switching harnesses actually
has: does the agent get the work done, and how long does it take?

Both harnesses get the same prompt, the same model, the same starting repository, and the same
grading — the task's own test suite plus a hidden test the agent never saw, so "the tests pass"
cannot mean "the agent's own tests pass".

## Running it

Needs `cast` on PATH, [mcode](https://www.npmjs.com/package/@minimax-ai/code) installed
(`mcode exec` runs one prompt without the TUI), and a MiniMax API key:

```bash
export MINIMAX_API_KEY=sk-...
node scripts/compare-with-mcode.mjs --runs 2
node scripts/compare-with-mcode.mjs --task task4 --runs 3
```

The tasks live in `scripts/compare-tasks/`. Each is a small repository with one deliberate defect
and a test suite that catches it:

| Task | Shape |
| --- | --- |
| `task1` | One-line comparison bug in a single file (`<` where `<=` belongs). |
| `task2` | A function described in `docs/spec.md` that has to be implemented, with a test written for it. |
| `task3` | A parser that does not strip `\r`, so a CRLF file parses wrong. |
| `task4` | Money in cents across six modules, where the tax helper contradicts its own doc comment and the caller compensates for it. |

`task2` is the only one with a hidden test (`hidden.test.js`); it is held back until the run is
over, so a `restock` that satisfies the agent's own test but not the spec still fails.

## Measured

2026-10-23, both harnesses on `MiniMax-M3.1-Flash` through `api.minimax.io`, four tasks, two runs
each — 16 runs in total. The report the numbers come from is
[`scripts/compare-report.json`](https://github.com/aa-blinov/cast/blob/master/scripts/compare-report.json).

| | cast | mcode |
| --- | --- | --- |
| Solved | 8/8 | 8/8 |
| Hidden test passed | 2/2 | 2/2 |
| Tests touched | 0 | 0 |
| Median wall time | 34s (9–49s) | 28s (19–58s) |
| Median tool calls | 13 | 8 |

Same outcome on every task, and the same fixes: on `task4` all four runs produced the identical
two-line change. The wall times are the same within the spread of a single run, and cast's is the
tighter one — its worst run was faster than mcode's worst.

cast spends about 1.6x the tool calls, on purpose: its prompts make the agent reproduce the
failure before changing anything and re-run the check afterwards, so a "fix" that never ran is not
a fix. That is the trade the harness makes, and on these tasks it costs nothing in outcome.

The numbers are a snapshot, not a promise: they move with the model, the provider and the day.
What the script is for is re-running the comparison after a change to cast's prompts or tools and
seeing the movement.

## What the script does not measure

- No TUI: both harnesses run headless (`cast run`, `mcode exec`). The terminal screen and the
  browser client are cast-only surfaces and are not part of the comparison.
- cast runs with its real configuration, MCP servers included; mcode runs with its own.
- One model on one provider. The behaviour bench covers more models; this covers the one the
  comparison is about.
