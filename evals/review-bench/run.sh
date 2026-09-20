#!/bin/bash
# Run /code-review over every prepared case against a running `cast server`.
# Writes one JSON line per attempt to $OUT (default results.jsonl).
#
# ATTEMPTS follows the scoreboard protocol in docs/eval-methodology.md: one
# attempt is a quick diagnostic, three is the number you compare on. Two runs of
# the same build scored 10/16 and 12/16 here, so a single attempt per case
# cannot tell a change from the noise.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/results.jsonl}"
PERSONA="${PERSONA:-senior}"
ATTEMPTS="${ATTEMPTS:-1}"
ADDR=$(python3 -c "import json;d=json.load(open('$HOME/.cast/server.json'));print(f\"{d['host']}:{d['port']}\")" 2>/dev/null) \
  || { echo "no running cast server — start one with 'cast server'"; exit 1; }
TOK=$(python3 -c "import json;print(json.load(open('$HOME/.cast/server.json'))['token'])")
: > "$OUT"
while IFS='|' read -r repo num dir; do
 for attempt in $(seq 1 "$ATTEMPTS"); do
  # Every attempt gets a fresh session and a fresh working tree. The reviewer
  # can write files, and an attempt that reviews the previous attempt's edits is
  # not a repeat of the same measurement.
  git -C "$dir" checkout -q -f . 2>/dev/null
  # -e keeps the patch itself, which lives untracked inside the work tree.
  git -C "$dir" clean -qfd -e .unfix.patch 2>/dev/null
  git -C "$dir" apply --whitespace=nowarn "$dir/.unfix.patch" 2>/dev/null \
    || { echo "skip $repo#$num — could not restore the fixture"; continue; }
  start=$(date +%s)
  SID=$(curl -s -m 20 -X POST "http://$ADDR/api/sessions" -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' -d "{\"cwd\":\"$dir\",\"persona\":\"$PERSONA\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null)
  [ -z "$SID" ] && continue
  curl -s -m 60 -X POST "http://$ADDR/api/sessions/$SID/command" -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' -d '{"command":"/code-review"}' > /dev/null
  # The turn is over when the session emits `end`. Match whitespace loosely: the
  # payload has no space after the colon, and a grep that assumed one silently
  # turned every case into a full-length timeout.
  for _ in $(seq 1 360); do
    if curl -s -m 10 "http://$ADDR/api/sessions/$SID/events/history" -H "authorization: Bearer $TOK" \
       | grep -q '"type":[[:space:]]*"end"'; then break; fi
    sleep 5
  done
  elapsed=$(( $(date +%s) - start ))
  curl -s -m 20 "http://$ADDR/api/sessions/$SID/events/history" -H "authorization: Bearer $TOK" | \
    REPO="$repo" NUM="$num" DIR="$dir" ELAPSED="$elapsed" SID="$SID" ATTEMPT="$attempt" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
call, verdicts = None, None
for e in d.get('events', []):
    p = e.get('payload', {})
    if p.get('type') == 'tool_start' and p.get('name') == 'review_report': call = p.get('args')
    if p.get('type') == 'tool_end' and p.get('name') == 'review_report': verdicts = (p.get('result') or {}).get('content')
print(json.dumps({'repo': os.environ['REPO'], 'pr': int(os.environ['NUM']), 'dir': os.environ['DIR'],
                  'sid': os.environ['SID'], 'attempt': int(os.environ['ATTEMPT']),
                  'seconds': int(os.environ['ELAPSED']),
                  'call': call, 'verdicts': verdicts}))
" >> "$OUT"
  echo "done $repo#$num${ATTEMPTS:+ (attempt $attempt/$ATTEMPTS)}"
 done
done < "$HERE/ready.tsv"
