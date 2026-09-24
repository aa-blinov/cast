# review-bench

Measures `/code-review` on merged bug-fix pull requests whose fix has been
reversed back out of the working tree. The planted defect's position is known
by construction, so recall can be counted rather than judged.

```bash
cast server                              # the bench drives a running daemon
evals/review-bench/prepare.sh            # clone + un-fix every case
ATTEMPTS=3 OUT=/tmp/base.jsonl evals/review-bench/run.sh
evals/review-bench/score.py /tmp/base.jsonl
```

`ATTEMPTS` follows the scoreboard protocol in `docs/eval-methodology.md`: one
attempt is a quick diagnostic, three is what you compare on. A case counts as
found only when every attempt found it; two out of three is reported as
instability, never as partial credit. Each attempt runs in a fresh session and
against a working tree restored with `reset --hard` (not `checkout -- .`, which
restores from the index and would hand back anything the reviewer staged). An
attempt that cannot run is still recorded, as a non-hit: dropping the row would
shrink the denominator and turn one lucky run out of three into "found 1/1".

The fixture is also restored after the last attempt, because `score.py` derives
ground truth from `git diff` at scoring time.

`cases.txt` is `repo|pr|(unused)|merge-sha|title`, one merged PR per line, each
one a fix that touches real source. Work trees land in `work/` (override with
`REVIEW_BENCH_WORK`), and `PERSONA` picks the persona under test.

## Where it stands

First run under the three-attempt protocol, `senior` persona:

```
found     9/16   every attempt found the planted defect
unstable  4/16   pallets/click#3865, pallets/click#3678,
                 sindresorhus/p-limit#109, sharkdp/fd#2127
missed    3/16   expressjs/express#6088, chalk/chalk#688, chalk/chalk#642
findings 80, median 164s
```

Those four unstable cases are why single-attempt runs of the same build scored
anywhere from 8/16 to 12/16.

## Read the numbers carefully

**Repeat a configuration before believing it.** Before the protocol was in
place, two runs of the same build gave 10/16 and 12/16, with four individual
cases flipping. The first round of this bench also produced three confident
conclusions that were all artefacts:

- the reverse patch was taken against the branch point instead of the merge's
  first parent, so every unrelated commit that landed in main while the PR was
  open came back as a "change" — and the review duly reported CI action
  downgrades as findings;
- the completion check grepped for `"type": "end"` while the payload has no
  space after the colon, so no case ever finished early and every duration was
  really the timeout;
- "findings on target" counted any finding on any changed line, which a review
  scores 100% on by definition, since changed lines are all it looks at.

The honest signals are `recall` (did it find the planted defect) and the raw
finding count (how much it says to get there).
