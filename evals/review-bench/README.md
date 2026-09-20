# review-bench

Measures `/code-review` on merged bug-fix pull requests whose fix has been
reversed back out of the working tree. The planted defect's position is known
by construction, so recall can be counted rather than judged.

```bash
cast server                              # the bench drives a running daemon
evals/review-bench/prepare.sh            # clone + un-fix every case
OUT=/tmp/base.jsonl evals/review-bench/run.sh
evals/review-bench/score.py /tmp/base.jsonl
```

`cases.txt` is `repo|pr|(unused)|merge-sha|title`, one merged PR per line, each
one a fix that touches real source. Work trees land in `work/` (override with
`REVIEW_BENCH_WORK`), and `PERSONA` picks the persona under test.

## Read the numbers carefully

**Repeat a configuration before believing it.** Two runs of the same build gave
10/16 and 12/16, with four individual cases flipping. Anything smaller than that
is noise, and the first round of this bench produced three confident conclusions
that were all artefacts:

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
