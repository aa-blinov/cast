# Behavior Evals

`evals/benches/behavior/` measures the real agent loop against a real configured model. A case
passes only from observable evidence: tool trace and arguments, turn grouping, filesystem state,
or mode signal. When a task asks the agent to report a fact, its final answer is also checked
against that independently observed state; prose alone never establishes correctness.

Run the default suite:

```bash
node --import tsx evals/run.ts -m <model> -j 1 -v
```

Each run records the complete trace in `evals/results/runs/`. Use it to investigate a failed
signal; do not rewrite a case to accept the model's explanation.

Cases live one-per-file under two subdirectories, wired together in each directory's `index.ts`:

- `evals/benches/behavior/tools/core/` — single-turn tool contracts (one tool call proves the
  point: a grounded argument, a required tool, a result read correctly).
- `evals/benches/behavior/tools/chain/` — multi-turn stateful workflows (tool ordering across
  turns, error recovery, plan/background/delegation lifecycles, MCP chains).

A case belongs in `core` only if a single tool call settles it; anything that needs a second turn
to prove — even "did it read before editing" — belongs in `chain`.

## Signals

The report deliberately has no composite score. Each case is tagged with one or more independent
signals (see `signals` on `EvalCase` in `evals/lib/runner.ts`), and the report prints independent
`passed/total` counts per signal:

- `required-tool` and `argument-grounding` — a required tool was used on the intended target.
- `tool-chain` — dependent work occurred in order, while unrelated extra reads remain valid.
- `filesystem-safety` — the resulting fixture state is exactly the requested bounded change.
- `mode-selection` and `plan-safety` — build/plan transition signals and forbidden writes.
- `plan-lifecycle` and `state-transition` — `plan_done` fires (or doesn't) at the right
  point, including re-entry reusing an existing plan file and an unresolved open question blocking
  `plan_done`.
- `state-persistence` — externalized state (todo list, active plan) survives and updates correctly
  across turns.
- `parallel-tools` — independent calls were issued in the same tool-call turn.
- `no-unneeded-tools` — a local read did not invoke shell or write tools.
- `tool-error-recovery` — a failed call (bad path, non-zero exit, ambiguous edit) is followed by
  the correct next step instead of stalling or silently faking success.
- `tool-result-integrity` — what a tool actually returned (not the model's prose about it) is what
  the rest of the run is grounded in — Unicode preserved, a bash error surfaced, an MCP result read.
- `background-lifecycle` — a backgrounded bash task is started, polled/killed by its own task id,
  and an explicit timeout is honored.
- `delegation` — the `task` tool is used for genuinely independent/parallel work, with the right
  subagent (`worker` for edits, `review` proactively after a non-trivial change).
- `skill-discovery` — a matching skill is loaded before answering; a non-matching request doesn't
  spuriously load one.
- `mcp-discovery` and `mcp-tool-chain` — a connected MCP server's tools are discovered, chained
  correctly, and an error result is treated as an error, not silently papered over.

Use a one-attempt run to develop or diagnose a case. Before calling a harness change a regression,
run `--repeat 3`; a split result is evidence of instability, not a partial pass. To publish a model
result, use `--scoreboard`, which runs those three attempts automatically and applies the stricter
consistent-3/3 scoring rule.

## What belongs where

Real-agent cases cover a model's use of the shipping prompt, tools, loop and provider protocol.
They should be small, sandboxed, and each prove one contract. Every case runs in an isolated
working directory unless it explicitly supplies a fixture directory, so an agent cannot obtain
accidental evidence from the Cast checkout running the evaluator.

Deterministic contracts stay in `test/`: plan terminal behavior and write gates in
`test/loop.test.ts`/`test/plan.test.ts`, session and compaction persistence in
`test/session.test.ts`, sandbox creation in `test/web-bridge.test.ts`, provider reasoning parsing
in `test/vendors.test.ts`, and Unicode rendering in `test/tools.test.ts` plus UI tests. They do
not need a paid LLM call to establish correctness.

The suite contains only small, hand-authored behavioral contracts. Precision mutation experiments
were removed: they mixed answer-quality benchmarking into the harness regression suite.
