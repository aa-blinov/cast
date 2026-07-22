# Eval Methodology

How `evals/` debugs and benchmarks `cast`'s own harness — what it measures, why it's built this
way, and how to read the output. This is an internal/development doc (see `AGENTS.md`'s project
layout: `evals/` is not part of the shipped package), not end-user documentation.

## Why this exists

A coding agent's behavior is a product of two things that are easy to conflate: the **model**
(does it understand the task, can it reason about the diff it needs to make) and the **harness**
(does the tool schema communicate the constraint clearly, does the edit format let the model
express its intent precisely, does the prompt wording bias it toward the right tool). When a task
fails, "the model is dumb" and "the harness set the model up to fail" produce the same visible
symptom — a wrong or rejected edit — but call for opposite fixes.

`evals/` exists to pull those two apart. Every case in it runs the real agent loop
(`runAgentLoop`, not a mock) against a real model through a real provider, so a passing case is
evidence about the actual system, not a simulation of it. The design choices below all serve one
goal: making it possible to tell "this is a model-capability gap" apart from "this is a
harness-communication gap" apart from "this is noise."

## Provenance

The mutation-based cases and the comparison methodology are a deliberate port of
[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)'s `packages/typescript-edit-benchmark`.
That project benchmarks coding-agent harnesses by injecting small mechanical bugs into real
TypeScript/React source files via AST mutation (Babel), describing each bug in plain English, and
grading whether the agent's edit restores the original file — run across ~180 tasks, 16 models,
3 edit-tool formats, 3 runs per task, with prettier-normalized comparison so formatting noise
doesn't count as failure.

cast's port keeps the core idea and deliberately narrows scope where the original's breadth
wasn't buying anything specific to cast's situation:

| | oh-my-pi | cast |
|---|---|---|
| Parser | Babel | TypeScript Compiler API (already a devDependency for `tsc` — zero new deps) |
| Mutation kinds | ~6 | 3 (comparison-operator swap, boolean flip, off-by-one) |
| Source corpus | vendored React files | cast's own `src/` (dogfooding, always in sync with the real codebase) |
| Edit-tool formats compared | 3 | 1 (cast only has one edit format — hashline — today; see "What isn't built yet" below) |
| Formatter for grading | prettier | biome (cast's own formatter) |
| Runs per task | 3 | configurable via `--repeat` (see below) |

The narrower mutation set is a precision choice, not a limitation worth fixing: cast's mutation
engine (`evals/benches/mutation/mutate.ts`) tests whether the model can locate and precisely apply
a described change through cast's actual edit tool — it is not trying to be a bug-finding
benchmark. Three well-understood, syntactically-unambiguous mutation shapes are enough to exercise
that; adding more categories would add surface area without adding a new failure mode worth
distinguishing.

## Directory layout

```
evals/
  lib/                  shared engine — not a bench itself
    runner.ts            EvalCase, runCase/runSuite, compareModels(Repeated), report printers
    results.ts           evals/results/ recording + history (index.json, runs/*.json)
    fixtures.ts           per-process /tmp fixture roots for grounded verify() checks
    trace-view.ts         --trace/--case: reads a recorded run back out turn-by-turn
  benches/
    index.ts             the bench registry — single source of truth for --bench/--list
    basic/cases.ts        hand-authored: fundamental agent capabilities
    hashline/cases.ts     hand-authored: cast's hashline edit-format regressions
    mutation/
      mutate.ts           AST mutation engine (TS Compiler API)
      format-compare.ts   biome-based format-tolerant grading
      cases.ts            generateMutationCases() — builds EvalCase[] on demand
  results/               output — timestamped run files + index.json (see "Recording results")
  run.ts                 CLI entrypoint
```

Each subdirectory under `evals/benches/` is a self-contained unit: a hand-authored bench is just a
`cases.ts` exporting an `EvalCase[]`; the mutation bench additionally owns its generator and
grading logic since neither is shared with anything else. `evals/benches/index.ts` is what wires a
directory into the CLI — adding a new bench means adding a subdirectory and one entry in that
registry's `BENCHES` array, nothing in `run.ts` itself needs to change.

## The independence thesis

The reason model-vs-harness separation is achievable at all: **hold the harness fixed, vary the
model** (`--compare model1,model2`), and any behavior difference that shows up is attributable to
the model, because every other variable — tool schemas, system prompt, edit format, grading logic
— is byte-for-byte identical between the two runs. Conversely, **hold the model fixed, vary the
harness** (a change to `tools.ts`'s schema wording, a different edit-format anchor scheme) and
re-run the same case set: any behavior difference is now attributable to the harness. cast's
`evals/run.ts --compare` implements the first axis today. The second axis — a `--edit-format`
switch analogous to oh-my-pi's 3-format comparison — isn't built, because cast currently ships
exactly one edit tool (hashline anchors); there is nothing to switch between yet. If cast grows a
second edit format, `compareModels`'s machinery generalizes directly to `compareFormats` with the
same report/record code, just varying `LoopConfig` instead of the model string.

`compareModels`/`compareModelsRepeated` flatten model×case (×repeat) into a single job list and
run it through one `--concurrency`-limited pool, not one model's full suite followed by the next
— every request across every model is independent, so there was never a reason to serialize
models behind each other. A 2-model compare over N cases now takes roughly as long as running N
cases against one model, not 2N; the `[k/total]` progress lines are labeled `<model> :: <case id>`
since jobs from both models now interleave in the log instead of appearing as two back-to-back
blocks.

## Two kinds of benches

**Hand-authored benches** (`evals/benches/basic/`, `evals/benches/hashline/`) encode specific
behavioral contracts: does the agent call the right tool, respect a `maxTurns` budget, avoid a
tool it shouldn't need. These are read by a human, so they're the right place for cases that check
something qualitative ("did it explain why," "did it avoid touching an unrelated file"). Both are
included by default (`DEFAULT_BENCH_IDS` in `evals/benches/index.ts` is every bench with a static
`cases` list) — a plain `-m <model>` run with no `--bench` covers them both.

**The auto-generated mutation bench** (`evals/benches/mutation/`) exists because hand-authoring an
edit-precision case is slow and the interesting variable — which file, which line, which token —
should be sampled, not curated. `generateMutationCases({count, seed, sourceDir})`
(`evals/benches/mutation/cases.ts`) walks `.ts` files in `sourceDir` (default `src/core`) in a
seeded-shuffled order, injects one AST-level mutation into a candidate file
(`evals/benches/mutation/mutate.ts`), and builds an `EvalCase` whose `verify` step reformats both
the agent's output and the known-correct original through biome and compares them
(`evals/benches/mutation/format-compare.ts`) — so an agent that fixes the bug but reindents a
line, or uses single vs. double quotes, still passes. Grading precision, not style, is the point.
It's excluded by default (it's not in `DEFAULT_BENCH_IDS`, since it costs real generation work and
a run count decision) — opt in with `--bench mutation` or `--generate/-g <n>`.

The mutation is described to the model in plain English naming the *category* and *location*
("A comparison or logical operator on line 47 was flipped, inverting the condition's logic"),
never the exact before/after values. This mirrors oh-my-pi's framing directly: the case measures
whether the agent can read the description, find the site, and make the precise edit through the
tool — not whether it can pattern-match a diff it was already handed.

Same `seed` always produces the same case set (`mulberry32` PRNG for site selection inside a file,
a separate seeded Fisher-Yates shuffle for file order) — a `--seed 7 -g 15` run today and the same
flags next month select identical mutations, so a regression between two dated runs in
`evals/results/` is comparing the same tasks, not different ones.

## Statistical validity: why `--repeat` exists

A single run of a stochastic model against a case set produces a pass/fail — but a model that
"passes" a case 2 times out of 3 will, on any single run, produce either a pass or a fail with no
way to tell which one you got. Treating a single-run comparison as a stable ranking silently
assumes attempts are deterministic, which they aren't.

This surfaced concretely, not hypothetically. An early `--compare mimo-v2.5,mimo-v2.5-pro --bench
mutation -g 15 --seed 7` single-run comparison showed mimo-v2.5 passing 15/15 generated cases
while mimo-v2.5-pro passed only 13/15 — both failures on structurally similar mutations (a boolean
literal flipped inside a comparison expression). That's a real, specific, reproducible-looking
signal... on one sample. It could mean the "pro" variant has a genuine blind spot around
compound boolean mutations, or it could mean two coin flips landed tails in a row. A single run
cannot distinguish these, and reporting it as a finding without a repeat would be exactly the kind
of overclaim this methodology exists to prevent.

`--repeat N` (`evals/run.ts`, backed by `runSuiteRepeated`/`compareModelsRepeated` in
`evals/lib/runner.ts`) runs every case N times, each attempt a **fresh agent session** (no shared
state between attempts — matching oh-my-pi's "fresh session each time," so an attempt's outcome
can't be contaminated by conversation history from a prior attempt), and reports `passed/N` per
case plus a consistency flag: `consistent: passed === 0 || passed === attempts.length`. A case
where every attempt agreed is a stable result. A case where attempts split is flagged with `⚠` in
the report and counted into `inconsistentCases` in the recorded JSON — visible at a glance instead
of silently averaged away. Concurrency spans the full case×repeat job list (not case-then-repeat
sequentially), so N repeats of one case don't serialize behind each other while unrelated cases
sit idle.

A case's aggregate "pass" under `--repeat` is majority-vote (`passed * 2 > total`), the same
convention oh-my-pi uses — a case is credited if the model gets it right more often than not,
while the `consistent` flag keeps the "how often" visible instead of collapsing it into a single
bit.

### Applying it to the anomaly above

Re-running the same seed-7, 15-case set with `-r 3`:

```
node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench mutation -g 15 --seed 7 -r 3 -v
```

```
Summary (majority-pass cases):
  mimo-v2.5                                               14/15 cases  (381.0s total, 3 runs/case)
  mimo-v2.5-pro                                           14/15 cases  (372.5s total, 3 runs/case)

⚠ 4 case(s) had disagreeing attempts on at least one model — see ⚠ above.
```

The aggregate gap disappeared: 14/15 vs 14/15, not 15/15 vs 13/15. The single-run "pro is worse"
read was, as suspected, mostly noise — 4 of the 15 cases had at least one model disagree with
itself across attempts, which is exactly the instability a single run can't see and shouldn't be
trusted to rank against.

That said, the repeat run isn't just "nothing to see here" — it surfaced a *real* difference the
single run had mislabeled. `mutate-boolean-flip-run-15` (a boolean literal flipped inside `if
(settings.webTools !== false)`) went **3/3 for mimo-v2.5 and a consistent 0/3 for
mimo-v2.5-pro** — every attempt on both sides agreed with itself, which is the strongest signal
`--repeat` can produce: not a coin flip, a stable behavioral split on one specific mutation shape.
Conversely `mutate-comparison-operator-swap-mcp-9` went the other way (0/3 for mimo-v2.5, 2/3 ⚠ for
mimo-v2.5-pro). Neither of these was visible in the original single-run table, which happened to
land on a different pair of cases entirely.

The methodological point: a single run's pass/fail table and a `--repeat` run's per-case
consistency table are answering different questions. The first tells you what happened once. The
second tells you which of those outcomes you can actually trust, and sometimes reveals a real,
narrow, reproducible gap that the aggregate score was hiding.

## Format-tolerant grading

`evals/benches/mutation/format-compare.ts` runs both the agent's output and the known-correct original through
biome (`biome format --stdin-file-path=...`) before comparing them, so a correct fix that happens
to differ in whitespace, quote style, or trailing-comma placement is not penalized. The
`--stdin-file-path` value doesn't need to point at a real file — biome only uses it to resolve
which `files.includes` glob in `biome.json` applies, so a synthetic `src/__eval_mutation__.ts`
path is always passed regardless of where the fixture actually lives on disk. This is the same
principle as oh-my-pi's prettier-normalization step: grade the *content* of the fix, not its
incidental formatting.

## Recording results

Every run — `-m`, `--compare`, with or without `--repeat` — is auto-recorded to
`evals/results/runs/<timestamp>_<kind>_<models>.json` (full per-case detail, including every
attempt's individual pass/fail under `--repeat`) with a one-line summary appended to
`evals/results/index.json` (`evals/lib/results.ts`). This replaced an earlier design that overwrote a
single `latest.json` on every run — useless for "how has this eval trended" or "what did the
2026-07-20 compare actually show" once a newer run has overwritten it. `evals/run.ts --history`
prints the index as a compact log, newest last, including the `⚠N inconsistent` marker for
repeated runs and the short commit hash the run was recorded at (`git rev-parse --short HEAD`) —
enough to correlate a regression with a specific harness change.

## Troubleshooting a failure: `--trace`

The pass/fail table (and even a failed-checks message) tells you *that* a case failed, not *why* —
and "why" is the only thing that turns a benchmark number into a harness fix. Every recorded case
now carries a full turn-by-turn `trace`: for each turn, the model's reasoning (`thinking`), any
user-visible commentary it produced, and — for every tool call it made — the exact args passed and
what the tool actually returned. Not just "it called `edit`," but what the `read` right before it
actually showed the model, and whether the `edit` result confirms the fix landed where the model
thought it did.

```bash
# List the case ids in the most recent recorded run
node --import tsx evals/run.ts --trace latest

# Full turn-by-turn trace for one case
node --import tsx evals/run.ts --trace latest --case glob-then-grep

# From a --compare file, narrow to one model's attempt(s)
node --import tsx evals/run.ts --trace latest --case glob-then-grep -m mimo-v2.5-pro
```

`<file>` can be `latest`, a path, or a bare filename under `evals/results/runs/`; `--case` selects
which case to expand (omit it to just list what's in the file). For a `--repeat` file, every
attempt is printed as its own block, in order — reading them side by side is often the fastest way
to see *what specifically* differed between an attempt that passed and one that didn't, rather than
just knowing they disagreed.

This is genuinely how a harness bug gets found, not a hypothetical: reading the trace of a
`--repeat` run's disagreeing attempts is exactly how you'd distinguish "the model's edit was
correct but the grading is comparing against the wrong ground truth" from "the model changed a
different line than it said it did" from "the tool result the model based its next step on was
truncated and it never noticed" — three different bugs (eval hygiene, model behavior, harness
UX) that produce the identical outer symptom (a red row in the compare table).

Implementation: `evals/lib/runner.ts`'s `runCase` builds `trace` from the same `AgentEvent` stream
the TUI and web UI render live (`assistant_message` for thinking/commentary/requested tool calls,
`turn_end.toolResults` for what each tool actually returned) — nothing synthetic, no re-derivation,
same events the shipping UI is built on. `evals/lib/trace-view.ts` reads it back out of a recorded
JSON file and pretty-prints it (truncating only the terminal display, never the stored JSON).

## What isn't built yet

- **Format comparison** (`--edit-format`, analogous to `--compare` but varying the edit tool
  instead of the model): not implemented, because cast has only one edit format today. The
  `compareModels`/`compareModelsRepeated` machinery in `evals/lib/runner.ts` generalizes to this
  directly if/when a second format exists — same report shape, same recording, just a different
  axis of `LoopConfig` held variable instead of `model`.
- **More mutation categories**: deliberately deferred, not missing — see "Provenance" above.

## Practical usage

```bash
# Every static bench (basic + hashline), one model
node --import tsx evals/run.ts -m mimo-v2.5 -v

# Just one bench
node --import tsx evals/run.ts -m mimo-v2.5 --bench hashline -v

# Compare two models, same harness, same bench
node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench hashline -v

# 15 fresh auto-generated edit-precision cases, compared across models, 3 attempts each
# (this is the way to get a result you can actually trust, not a single-sample anecdote)
node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench mutation -g 15 --seed 7 -r 3 -v

# List benches and the cases the current flag selection would run
node --import tsx evals/run.ts --list

# What's been run before
node --import tsx evals/run.ts --history

# Troubleshoot a failure — full turn-by-turn trace for one case
node --import tsx evals/run.ts --trace latest --case <case-id>
```

See `evals/run.ts --help` for the full flag reference.
