#!/bin/bash
# Materialise each case "un-fixed": check out the merge commit, then reverse the
# PR's own diff into the working tree. `/code-review` (working tree vs HEAD)
# then reviews exactly the removal of a fix whose position is known.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="${REVIEW_BENCH_WORK:-$HERE/work}"
mkdir -p "$W"
: > "$HERE/ready.tsv"
while IFS='|' read -r repo num _base merge _title; do
  [ -z "${merge:-}" ] && continue
  dir="$W/$(echo "$repo" | tr / _)-$num"
  if [ ! -d "$dir/.git" ]; then
    git clone -q --filter=blob:none --no-checkout "https://github.com/$repo.git" "$dir" 2>/dev/null || continue
    git -C "$dir" fetch -q --depth 50 origin "$merge" 2>/dev/null || git -C "$dir" fetch -q origin 2>/dev/null
  fi
  git -C "$dir" checkout -q -f "$merge" 2>/dev/null || continue
  git -C "$dir" clean -qfd 2>/dev/null
  # `merge` against its FIRST PARENT, not against the branch point: everything
  # else that landed in main while the PR was open lives between those two and
  # would otherwise be reverted along with the fix.
  if git -C "$dir" diff "$merge" "$merge^1" > "$dir/.unfix.patch" 2>/dev/null && [ -s "$dir/.unfix.patch" ]; then
    if git -C "$dir" apply --whitespace=nowarn "$dir/.unfix.patch" 2>/dev/null; then
      echo "$repo|$num|$dir" >> "$HERE/ready.tsv"
    fi
  fi
done < "$HERE/cases.txt"
wc -l < "$HERE/ready.tsv"
