# Eval Methodology

How `evals/` debugs and benchmarks `cast`'s own harness — what it measures, why it's built this
way, and how to read the output. This is an internal/development doc (see `AGENTS.md`'s project
layout: `evals/` is not part of the shipped package), not end-user documentation.

## Why this exists

A coding agent's behavior is a product of two things that are easy to conflate: the **model**
(does it understand the task, can it reason about the diff it needs to make) and the **harness**
(does the tool schema communicate the constraint clearly, does the system prompt bias it toward
the right tool, does a documented protocol like plan-mode's RE-ENTRY step actually get followed).
When a case fails, "the model is dumb" and "the harness set the model up to fail" produce the same
visible symptom — a wrong tool call, a skipped step — but call for opposite fixes.

`evals/` exists to pull those two apart. Every case runs the real agent loop (`runAgentLoop`, not a
mock) against a real model through a real provider, so a passing case is evidence about the actual
system, not a simulation of it. See `docs/eval-behavior.md` for what's actually being measured
(signals, the `core`/`chain` split); this doc covers the runner mechanics: comparison, statistical
validity, baselines, and trace-based debugging.

## What the scoreboard is for

The Model Scoreboard is a certification artifact for selecting a model **for Cast**, not a general
leaderboard of model intelligence or coding quality. It answers: with this exact system prompt,
tool surface, agent loop, and provider protocol, does a model reliably choose grounded tool calls,
complete stateful workflows, and respect the harness lifecycle?

That distinction changes how to use a low score. It is evidence to inspect the trace, not a verdict
that a model is "bad": the cause may be a model limitation, an ambiguous behavioral contract, or a
harness regression. A high, stable score is evidence that the model is suitable for Cast; it does
not imply it is best for unrelated tasks or under another harness.

The scoreboard is intentionally built from one fixed experimental protocol: every case runs exactly
three times in fresh sessions. This makes each row comparable without displaying a redundant attempt
count. A case earns scoreboard credit only when all three attempts pass; a 2/3 result remains visible
as instability, not a partial success.

This does not make one-attempt runs invalid. The normal CLI defaults to one attempt so a developer
can quickly validate a new case, inspect a trace, or iterate on a harness change. `--scoreboard`
automatically runs exactly three attempts (an explicit `--repeat 3` is accepted); quick runs are
diagnostic evidence, not certification data.

## Directory layout

```
evals/
  lib/                       shared engine — not a bench itself
    runner.ts                 EvalCase, runCase/runSuite, compareModels(Repeated), report printers
    baseline.ts                saved-snapshot regression detection (statistical significance)
    results.ts                 evals/results/ recording + history (index.json, runs/*.json)
    fixtures.ts                 per-process /tmp fixture roots for grounded verify() checks
    trace-view.ts               --trace/--case: reads a recorded run back out turn-by-turn
  benches/
    index.ts                  the bench registry — single source of truth for --bench/--list
    behavior/tools/
      core/                    single-turn tool contracts, one file per case + index.ts
      chain/                   multi-turn stateful workflows, one file per case + index.ts
  fixtures/                  committed fixtures cases need on disk (e.g. an MCP test server, an image)
  results/                   output — timestamped run files + index.json (see "Recording results")
  baselines/                 saved regression-detection snapshots (see below)
  run.ts                     CLI entrypoint
```

`evals/benches/index.ts` is what wires a bench into the CLI — currently a single `behavior` bench
combining `core` and `chain` cases, since `DEFAULT_BENCH_IDS` includes every bench with a static
`cases` list and there's only the one. Adding a second bench means adding a subdirectory under
`evals/benches/` and one entry in that registry's `BENCHES` array — nothing in `run.ts` itself
needs to change.

## The independence thesis

The reason model-vs-harness separation is achievable at all: **hold the harness fixed, vary the
model** (`--compare model1,model2`), and any behavior difference that shows up is attributable to
the model, because every other variable — tool schemas, system prompt, loop, grading logic — is
byte-for-byte identical between the two runs. Conversely, **hold the model fixed, vary the
harness** (a change to `tools.ts`'s schema wording, a prompt edit) and re-run the same case set: any
behavior difference is now attributable to the harness.

`compareModels`/`compareModelsRepeated` flatten model×case (×repeat) into a single job list and run
it through one `--concurrency`-limited pool, not one model's full suite followed by the next —
every request across every model is independent, so there was never a reason to serialize models
behind each other. A 2-model compare over N cases takes roughly as long as running N cases against
one model, not 2N; the `[k/total]` progress lines are labeled `<model> :: <case id>` since jobs from
both models interleave in the log instead of appearing as two back-to-back blocks.

## Statistical validity: why `--repeat` exists

A single run of a stochastic model against a case set produces a pass/fail — but a model that
"passes" a case 2 times out of 3 will, on any single run, produce either a pass or a fail with no
way to tell which one you got. Treating a single-run result as a stable signal silently assumes
attempts are deterministic, which they aren't — this session's own work on `plan-done-signal` and
`plan-open-question-blocks-done` hit exactly this: the same model, same case, disagreeing with
itself across consecutive runs on a genuine judgment call.

`--repeat N` (`evals/run.ts`, backed by `runSuiteRepeated`/`compareModelsRepeated` in
`evals/lib/runner.ts`) runs every case N times, each attempt a **fresh agent session** (no shared
state between attempts, so an attempt's outcome can't be contaminated by conversation history from
a prior one), and reports `passed/N` per case plus a consistency flag:
`consistent: passed === 0 || passed === attempts.length`. A case where every attempt agreed is a
stable result. A case where attempts split is flagged with `⚠` in the report and counted into
`inconsistentCases` in the recorded JSON — visible at a glance instead of silently averaged away.
Concurrency spans the full case×repeat job list (not case-then-repeat sequentially), so N repeats
of one case don't serialize behind each other while unrelated cases sit idle.

A case's aggregate "pass" under `--repeat` is majority-vote (`passed * 2 > total`) — a case is
credited if the model gets it right more often than not, while the `consistent` flag keeps the "how
often" visible instead of collapsing it into a single bit.

Practical rule: before calling a change a regression (or a model gap a real finding), run
`--repeat 3`. A split result is evidence of instability, not a partial pass — investigate the
disagreeing attempts with `--trace` (see below) before concluding anything.

## Recording results

Every run — `-m`, `--compare`, with or without `--repeat` — is auto-recorded to
`evals/results/runs/<timestamp>_<kind>_<models>.json` (full per-case detail, including every
attempt's individual pass/fail under `--repeat`) with a one-line summary appended to
`evals/results/index.json` (`evals/lib/results.ts`). `evals/run.ts --history` prints the index as a
compact log, newest last, including the `⚠N inconsistent` marker for repeated runs and the short
commit hash the run was recorded at (`git rev-parse --short HEAD`) — enough to correlate a
regression with a specific harness change.

## Cost & token tracking

Every run reports token usage and (when the provider reports it) USD cost alongside the pass/fail
table, so a model's win doesn't hide behind a much larger token spend.

For a single-model run the summary prints per-case `(tokens, cost)` and the suite ends with a
`Usage:` block (total / prompt / completion / cache-hit / uncached / cost):

```
EVAL RESULTS: 1/1 passed (1796ms)
Summary:
  ✓ background-bash-output (8125ms, 4 turns, 32442 tokens, $0.0009)
Usage:
  Total tokens: 32,442
    Prompt: 32,196
    Completion: 246
    Cache read: 28,448
    Uncached: 3,748
  Total cost: $0.0009
```

`--compare` collapses these into a side-by-side row per model (`passed/total, duration, tokens,
cost`), and `--repeat` aggregates across all attempts. Recorded JSON carries the same numbers at
both the suite level (`usage`) and per case (`cases[i].usage`) so downstream tooling (dashboards,
regression detectors) can read them without re-parsing the report.

Token buckets: `promptTokens` (input), `completionTokens` (output), `totalTokens`, `cacheReadTokens`
(provider prompt-cache hit), `cacheWriteTokens` (cache miss / new entry), `uncachedTokens` (full-
price input). `cost` is USD from the provider when it reports one — `n/a` otherwise (not every
provider returns it).

## Regression detection: `--save-baseline` / `--baseline`

A baseline is a saved snapshot of a suite result keyed by bench+model. Subsequent runs can compare
against it to catch *gradual* drift that no single run can see: a series of PRs each shave 1–2pp off
the pass rate, and no individual commit looks like it broke anything when reviewed in isolation.
Baselines are the mechanism that flips "did this PR regress?" from an inline review judgement call
into a number.

The regression flag is driven by a **two-proportion z-test** (one-sided: "current is worse than
baseline"). Reject H0 only when the observed pass-rate drop is unlikely under the assumption that
the true rates are equal, calibrated by `--significance-alpha` (default 0.05 = 95%). Below ~10
common cases the test isn't reliable, so the run falls back to the simpler
`--regression-threshold` percentage-point rule (default 5pp) — the same intuition, scoped to small
samples where the z-test can't say anything informative.

Baselines live under `evals/baselines/` in two layers — one tier for the "latest" pointer that
`compareToBaseline` actually reads, and a `history/` subdir for the full timeline of every
`--save-baseline`:

```
evals/baselines/
  behavior-poolside-laguna-s-2.1.json                 ← latest pointer (what --baseline reads)
  history/
    2026-07-25T19-28-39-590Z_behavior-poolside-laguna-s-2.1.json  ← every save is timed-stamped
    2026-07-26T10-15-22-107Z_behavior-poolside-laguna-s-2.1.json  ← sorted chronologically by name
```

Every `--save-baseline` writes a new dated copy to `history/` *and* refreshes the top-level
"latest" file in one shot — so the latest pointer is always the most recent snapshot, and
`history/` is a complete audit log of what the benchmark looked like at every commit. Both tiers
are tracked in git so baselines move with the codebase they correspond to (the `commit` recorded
inside each baseline lets `--history` correlate snapshots to commits).

`--baseline <name>` reads only the latest pointer. To see the full timeline of one baseline (e.g.,
to diff "two weeks ago vs today"), use `--baseline-history <name>`. `--list-baselines` lists the
latest pointers (one per bench+model); `--baseline-history` lists snapshots of one.

```bash
# Save the current run's result as the baseline for bench=behavior, model=m
node --import tsx evals/run.ts -m <model> --save-baseline

# Save to a custom name (otherwise name is auto-generated as <bench>-<model>)
node --import tsx evals/run.ts -m <model> --save-baseline --baseline "release-2026-07"

# Compare the next run against the saved baseline; non-zero exit on regression
node --import tsx evals/run.ts -m <model> --baseline behavior-<model>

# Tighten / loosen the significance test (default α=0.05)
node --import tsx evals/run.ts -m <model> --baseline behavior-<model> --significance-alpha 0.01

# Tighten / loosen the small-sample fallback (default 5pp)
node --import tsx evals/run.ts -m <model> --baseline behavior-<model> --regression-threshold 3

# List every "latest" baseline (one per bench+model)
node --import tsx evals/run.ts --list-baselines

# Full per-save history for one baseline, newest first
node --import tsx evals/run.ts --baseline-history behavior-<model>
```

A regression report prints the statistical evidence first, then aggregate deltas, then the per-case
moves that explain the drop. Illustrative shape (numbers made up, not a real recorded run):

```
==================================================================
REGRESSION CHECK
==================================================================
Comparing against baseline "behavior-poolside-laguna-s-2.1" (..., @9fdac84 31/33 passing, 93.9%):
  Pass rate: 29/33 (-6.1pp) (baseline: 31/33 (+0.0pp), -2/33 (-6.1pp))
  Significance: p=0.1421 (α=0.05), effect size h=0.184, LOW N — see threshold fallback
  Confidence intervals (95%): baseline 79.8%–98.3%, current 71.3%–95.3%
  Total tokens: 965,877 (baseline: 940,332, +25,545)
  Duration: 118,605ms (baseline: 73,758ms, +44,847ms)
```

The "significance block" tells you *why* the run did or didn't trip the regression flag:

- `p < α` (e.g. p=0.0031 < 0.05) → `*` marker, IS a statistically significant regression.
- `p ≥ α` but sample is too small for the z-test to be reliable (n < 10) →
  "LOW N — see threshold fallback" — and the flag follows `--regression-threshold` percentage points.
- Effect size is Cohen's h, computed as `|2·asin(√p1) − 2·asin(√p2)|`; convention 0.2 small, 0.5 medium,
  0.8 large. Reported alongside p so you can tell "significant but trivial" from "significant and
  meaningful".
- CIs are Wilson-score 95% intervals per run — the wider the overlap of the two, the less likely
  the current drop is real rather than sampling noise.

Per-case regression / improvement detection is structural (case-id matching): cases passing in
baseline but failing now go in `Regressions`, the symmetric move in `Improvements`. These are
always computed on the *common* case subset — cases added since the baseline are silently ignored
(no comparison possible — not a regression). The significance test uses the same subset, so a new
or removed case can't tilt the z-test by inflating the denominator.

When cases don't match 1:1 (e.g. baseline had 20 cases, current run covers 33 after new cases were
added) the report falls back to: pass rate reported as aggregate, significance computed on the
common subset. Running the full current suite and saving a new baseline is how you re-establish
broader coverage.

## Troubleshooting a failure: `--trace`

The pass/fail table (and even a failed-checks message) tells you *that* a case failed, not *why* —
and "why" is the only thing that turns a benchmark number into a harness fix or a real model-gap
finding. Every recorded case carries a full turn-by-turn `trace`: for each turn, the model's
reasoning (`thinking`), any user-visible commentary it produced, and — for every tool call it
made — the exact args passed and what the tool actually returned. Not just "it called `edit`," but
what the `read` right before it actually showed the model, and whether the tool's own result
confirms what the model claimed happened.

```bash
# List the case ids in the most recent recorded run
node --import tsx evals/run.ts --trace latest

# Full turn-by-turn trace for one case
node --import tsx evals/run.ts --trace latest --case plan-done-signal

# From a --compare file, narrow to one model's attempt(s)
node --import tsx evals/run.ts --trace latest --case plan-done-signal -m gpt-5.6-luna
```

`<file>` can be `latest`, a path, or a bare filename under `evals/results/runs/`; `--case` selects
which case to expand (omit it to just list what's in the file). For a `--repeat` file, every
attempt is printed as its own block, in order — reading them side by side is often the fastest way
to see *what specifically* differed between an attempt that passed and one that didn't, rather than
just knowing they disagreed.

This is genuinely how a harness bug gets found, not a hypothetical. Reading a case's trace is how
this project's own eval work told apart, on separate occasions: a genuinely wrong `expect` contract
(`maxTurns: 1` on a plan-mode case whose own system prompt mandates a preliminary `ls`+`read`), a
wrong argument name in a `verify` function (`args.path` vs. `edit`'s actual `args.filePath`), a real
product bug two layers down (the `grep` fallback silently returning zero matches when `path` named
a single file, not a directory) — and a genuine, reproducible model weakness (hedging a plan with
both options instead of converging, then calling `plan_done` anyway). Four different failure
classes that would otherwise look identical from the pass/fail table alone: a red row saying the
same thing regardless of which of those it actually was.

Implementation: `evals/lib/runner.ts`'s `runCase` builds `trace` from the same `AgentEvent` stream
the TUI and web UI render live (`assistant_message` for thinking/commentary/requested tool calls,
`turn_end.toolResults` for what each tool actually returned) — nothing synthetic, no re-derivation,
same events the shipping UI is built on. `evals/lib/trace-view.ts` reads it back out of a recorded
JSON file and pretty-prints it (truncating only the terminal display, never the stored JSON).

## What isn't built yet

Harness-level guardrails (doom-loop detection, dangerous-command confirmation, the automatic
background-task completion reminder) are deliberately covered by `test/` unit tests, not behavior
cases here — they're enforced by code regardless of what the model does, so a behavior case would
just be re-testing the guardrail rather than the model. See `docs/eval-behavior.md`'s "What belongs
where" for the split.

## Practical usage

```bash
# Fast development check: one attempt per case (the default)
node --import tsx evals/run.ts -m <model> -v

# Narrow to cases matching a prefix
node --import tsx evals/run.ts -m <model> --cases plan- -v

# Compare two models, same harness, same suite
node --import tsx evals/run.ts --compare <model1>,<model2> -v

# Diagnose stability without changing the scoreboard
node --import tsx evals/run.ts --compare <model1>,<model2> --repeat 3 -v

# Publish comparable certification results: --scoreboard automatically uses three attempts.
node --import tsx evals/run.ts --compare <model1>,<model2> --scoreboard -v

# Equivalent explicit spelling, retained for scripts.
node --import tsx evals/run.ts --compare <model1>,<model2> --repeat 3 -v

# List benches and the cases the current flag selection would run
node --import tsx evals/run.ts --list

# What's been run before
node --import tsx evals/run.ts --history

# Troubleshoot a failure — full turn-by-turn trace for one case
node --import tsx evals/run.ts --trace latest --case <case-id>
```

See `evals/run.ts --help` for the full flag reference.
