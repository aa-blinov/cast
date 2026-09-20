#!/usr/bin/env python3
"""Score one or more review-bench runs.

Ground truth is built by construction: the working tree of each case is the
merge commit with the PR's own diff reversed, so `git diff -U0` names exactly
the lines the fix touched. A case is a hit when some finding lands within three
lines of one of those ranges in a source file.

Scoring follows the scoreboard protocol in docs/eval-methodology.md: a case
counts as found only when EVERY attempt found it. A split (say 2 of 3) is
reported as instability, not as partial credit, because that is the honest
reading — two runs of the same build scored 10/16 and 12/16 here with four
cases flipping, so a single attempt per case cannot tell a change from noise.

Pass two or more result files to compare them.
"""
import json
import re
import statistics
import subprocess
import sys

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
SOURCE = re.compile(r"\.(ts|tsx|js|mjs|cjs|py|go|rs)$")
SLACK = 3


def truth_ranges(repo_dir):
    """New-side changed line ranges per file — the planted defect."""
    diff = subprocess.run(
        ["git", "-C", repo_dir, "diff", "-U0"], capture_output=True, text=True
    ).stdout
    ranges, current = {}, None
    for line in diff.split("\n"):
        if line.startswith("+++ b/"):
            current = line[6:]
            ranges.setdefault(current, [])
        match = HUNK.match(line)
        if match and current:
            start = int(match.group(1))
            count = 1 if match.group(2) is None else int(match.group(2))
            ranges[current].append((start, start if count == 0 else start + count - 1))
    return ranges


def score(path):
    """Fold every attempt of a case into one verdict: found / split / missed."""
    attempts = {}
    for line in open(path):
        row = json.loads(line)
        truth = truth_ranges(row["dir"])
        reported = json.loads(row["call"])["findings"] if row["call"] else []
        hit = any(
            SOURCE.search(f["path"])
            and any(a - SLACK <= f["line"] <= b + SLACK for a, b in truth.get(f["path"], []))
            for f in reported
        )
        attempts.setdefault(f"{row['repo']}#{row['pr']}", []).append(
            (hit, len(reported), row["seconds"])
        )

    per_case, found, split, findings, seconds = {}, 0, 0, 0, []
    for case, tries in attempts.items():
        hits = sum(1 for hit, _, _ in tries if hit)
        # All attempts, or it did not hold. A 2/3 is instability, not a pass.
        verdict = "found" if hits == len(tries) else "split" if hits else "missed"
        per_case[case] = (verdict, hits, len(tries),
                          statistics.median([n for _, n, _ in tries]),
                          statistics.median([s for _, _, s in tries]))
        found += verdict == "found"
        split += verdict == "split"
        findings += sum(n for _, n, _ in tries)
        seconds += [s for _, _, s in tries]
    return per_case, found, split, len(attempts), findings, statistics.median(seconds or [0])


def main(paths):
    scored = [(p, *score(p)) for p in paths]
    names = [p.rsplit("/", 1)[-1].replace(".jsonl", "") for p in paths]
    print(f"{'case':<30}" + "".join(f"{n:>26}" for n in names))
    for case in scored[0][1]:
        cells = ""
        for _, per_case, *_ in scored:
            verdict, hits, tries, count, secs = per_case.get(case, ("absent", 0, 0, 0, 0))
            cells += f"{verdict:>9} {hits}/{tries}  f={count:<4.0f}{secs:>5.0f}s"
        print(f"{case:<30}{cells}")
    print()
    for (_, _, found, split, total, findings, median), name in zip(scored, names):
        note = f"   ({split} unstable)" if split else ""
        print(f"{name:<22} found {found}/{total}{note}   findings {findings}   median {median:.0f}s")
    if any(s[3] for s in scored):
        print("\nUnstable cases found the defect in some attempts and not others. They are"
              "\nnot partial credit: they are the reason one attempt per case proves nothing.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
