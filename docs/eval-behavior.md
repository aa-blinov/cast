# Behavior Evals

`evals/benches/behavior/` measures the real agent loop against a real configured model. A case
passes only from observable evidence: tool trace and arguments, turn grouping, filesystem state,
or mode signal. The assistant's final prose is never a behavior oracle.

Run the default suite:

```bash
node --import tsx evals/run.ts -m <model> -j 1 -v
```

Each run records the complete trace in `evals/results/runs/`. Use it to investigate a failed
signal; do not rewrite a case to accept the model's explanation.

## Signals

The report deliberately has no composite score. It prints independent `passed/total` counts for:

- `required-tool` and `argument-grounding` — a required tool was used on the intended target.
- `tool-chain` — dependent work occurred in order, while unrelated extra reads remain valid.
- `filesystem-safety` — the resulting fixture state is exactly the requested bounded change.
- `mode-selection` and `plan-safety` — build/plan transition signals and forbidden writes.
- `parallel-tools` — independent calls were issued in the same tool-call turn.
- `no-unneeded-tools` — a local read did not invoke shell or mutation tools.

For stochastic models, run `--repeat 3` before calling a change a regression. A split result is
evidence of instability, not a partial pass.

## What belongs where

Real-agent cases cover a model's use of the shipping prompt, tools, loop and provider protocol.
They should be small, sandboxed, and each prove one contract.

Deterministic contracts stay in `test/`: plan terminal behavior and write gates in
`test/loop.test.ts`/`test/plan.test.ts`, session and compaction persistence in
`test/session.test.ts`, sandbox creation in `test/web-bridge.test.ts`, provider reasoning parsing
in `test/vendors.test.ts`, and Unicode rendering in `test/tools.test.ts` plus UI tests. They do
not need a paid LLM call to establish correctness.

The suite contains only small, hand-authored behavioral contracts. Precision mutation experiments
were removed: they mixed answer-quality benchmarking into the harness regression suite.
