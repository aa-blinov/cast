#!/usr/bin/env python3
"""Score one or more review-bench runs.

Ground truth is built by construction: the working tree of each case is the
merge commit with the PR's own diff reversed, so `git diff -U0` names exactly
the lines the fix touched. A case is a hit when some finding lands within three
lines of one of those ranges in a source file.

Pass two or more result files to compare them. Two runs of the SAME build
differed by two cases out of sixteen when this was written, so treat anything
smaller than that as noise and repeat a configuration before believing it.
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
    rows = [json.loads(line) for line in open(path)]
    hits, findings, seconds, per_case = 0, 0, [], {}
    for row in rows:
        truth = truth_ranges(row["dir"])
        reported = json.loads(row["call"])["findings"] if row["call"] else []
        hit = any(
            SOURCE.search(f["path"])
            and any(a - SLACK <= f["line"] <= b + SLACK for a, b in truth.get(f["path"], []))
            for f in reported
        )
        per_case[f"{row['repo']}#{row['pr']}"] = (hit, len(reported), row["seconds"])
        hits += hit
        findings += len(reported)
        seconds.append(row["seconds"])
    return per_case, hits, len(rows), findings, statistics.median(seconds or [0])


def main(paths):
    scored = [(p, *score(p)) for p in paths]
    names = [p.rsplit("/", 1)[-1].replace(".jsonl", "") for p in paths]
    first = scored[0][1]
    print(f"{'case':<30}" + "".join(f"{n:>22}" for n in names))
    for case in first:
        cells = ""
        for _, per_case, *_ in scored:
            hit, count, secs = per_case.get(case, (None, 0, 0))
            cells += f"{'hit=' + str(hit):>10} f={count:<3}{secs:>5}s"
        print(f"{case:<30}{cells}")
    print()
    for (_, _, hits, total, findings, median), name in zip(scored, names):
        print(f"{name:<22} recall {hits}/{total}   findings {findings}   median {median:.0f}s")
    if len(scored) > 1:
        a, b = scored[0][1], scored[1][1]
        flipped = [c for c in a if c in b and a[c][0] != b[c][0]]
        print(f"\n{names[0]} vs {names[1]}: {len(flipped)} case(s) flipped — {', '.join(flipped) or 'none'}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
