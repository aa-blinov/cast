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
# A bind address is not a dial address: 0.0.0.0 and :: have to be translated,
# the same way daemonBaseUrl() does it in src/server/daemon-state.ts.
ADDR=$(python3 -c "
import json
d = json.load(open('$HOME/.cast/server.json'))
host = {'0.0.0.0': '127.0.0.1', '::': '[::1]'}.get(d['host'], d['host'])
print(f\"{host}:{d['port']}\")" 2>/dev/null) \
  || { echo "no running cast server — start one with 'cast server'"; exit 1; }
TOK=$(python3 -c "import json;print(json.load(open('$HOME/.cast/server.json'))['token'])")
: > "$OUT"

# One writer for every attempt, successful or not. Takes the event history on
# stdin ("" for an attempt that never ran).
record_attempt() {
  REPO="$1" NUM="$2" DIR="$3" SID="$4" ELAPSED="$5" ATTEMPT="$6" python3 -c "
import sys, json, os
raw = sys.stdin.read()
call, verdicts = None, None
if raw.strip():
    for e in json.loads(raw).get('events', []):
        p = e.get('payload', {})
        if p.get('type') == 'tool_start' and p.get('name') == 'review_report': call = p.get('args')
        if p.get('type') == 'tool_end' and p.get('name') == 'review_report': verdicts = (p.get('result') or {}).get('content')
print(json.dumps({'repo': os.environ['REPO'], 'pr': int(os.environ['NUM']), 'dir': os.environ['DIR'],
                  'sid': os.environ['SID'], 'attempt': int(os.environ['ATTEMPT']),
                  'seconds': int(os.environ['ELAPSED']),
                  'call': call, 'verdicts': verdicts}))
" >> "$OUT"
}
while IFS='|' read -r repo num dir; do
 for attempt in $(seq 1 "$ATTEMPTS"); do
  # Every attempt gets a fresh session and a fresh working tree. The reviewer
  # can write files, and an attempt that reviews the previous attempt's edits is
  # not a repeat of the same measurement.
  # reset --hard, not checkout -- .: the latter restores from the index, so a
  # reviewer that staged anything would have its edits restored as the fixture.
  git -C "$dir" reset --hard -q 2>/dev/null
  # -e keeps the patch itself, which lives untracked inside the work tree.
  git -C "$dir" clean -qfd -e .unfix.patch 2>/dev/null
  start=$(date +%s)
  if ! git -C "$dir" apply --whitespace=nowarn "$dir/.unfix.patch" 2>/dev/null; then
    echo "failed $repo#$num — could not restore the fixture"
    record_attempt "$repo" "$num" "$dir" "" 0 "$attempt" < /dev/null
    continue
  fi
  SID=$(curl -s -m 20 -X POST "http://$ADDR/api/sessions" -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' -d "{\"cwd\":\"$dir\",\"persona\":\"$PERSONA\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null)
  # An attempt that could not run is a failed attempt, not an absent one: drop
  # the row and the case is scored over a smaller denominator, so one lucky run
  # out of three reports a unanimous "found 1/1".
  if [ -z "$SID" ]; then
    echo "failed $repo#$num — no session"
    record_attempt "$repo" "$num" "$dir" "" "$(( $(date +%s) - start ))" "$attempt" < /dev/null
    continue
  fi
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
  curl -s -m 20 "http://$ADDR/api/sessions/$SID/events/history" -H "authorization: Bearer $TOK" \
    | record_attempt "$repo" "$num" "$dir" "$SID" "$elapsed" "$attempt"
  if [ "$ATTEMPTS" -gt 1 ]; then echo "done $repo#$num (attempt $attempt/$ATTEMPTS)"; else echo "done $repo#$num"; fi
 done
 # Leave the fixture as score.py expects to find it. The scorer derives ground
 # truth from `git diff` at scoring time, so a tree left holding the last
 # reviewer's edits would move the truth for every attempt of this case at once.
 git -C "$dir" reset --hard -q 2>/dev/null
 git -C "$dir" clean -qfd -e .unfix.patch 2>/dev/null
 git -C "$dir" apply --whitespace=nowarn "$dir/.unfix.patch" 2>/dev/null \
   || echo "warning: $repo#$num left un-restored — scoring it will be wrong"
done < "$HERE/ready.tsv"
