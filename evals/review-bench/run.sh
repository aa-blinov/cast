#!/bin/bash
# Run /code-review over every prepared case against a running `cast server`.
# Writes one JSON line per case to $OUT (default results.jsonl).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/results.jsonl}"
PERSONA="${PERSONA:-senior}"
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.cast/server.json'))['url'].split('//')[1])" 2>/dev/null) \
  || { echo "no running cast server — start one with 'cast server'"; exit 1; }
TOK=$(python3 -c "import json;print(json.load(open('$HOME/.cast/server.json'))['token'])")
: > "$OUT"
while IFS='|' read -r repo num dir; do
  start=$(date +%s)
  SID=$(curl -s -m 20 -X POST "http://$PORT/api/sessions" -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' -d "{\"cwd\":\"$dir\",\"persona\":\"$PERSONA\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null)
  [ -z "$SID" ] && continue
  curl -s -m 60 -X POST "http://$PORT/api/sessions/$SID/command" -H "authorization: Bearer $TOK" \
    -H 'content-type: application/json' -d '{"command":"/code-review"}' > /dev/null
  # The turn is over when the session emits `end`. Match whitespace loosely: the
  # payload has no space after the colon, and a grep that assumed one silently
  # turned every case into a full-length timeout.
  for _ in $(seq 1 360); do
    if curl -s -m 10 "http://$PORT/api/sessions/$SID/events/history" -H "authorization: Bearer $TOK" \
       | grep -q '"type":[[:space:]]*"end"'; then break; fi
    sleep 5
  done
  elapsed=$(( $(date +%s) - start ))
  curl -s -m 20 "http://$PORT/api/sessions/$SID/events/history" -H "authorization: Bearer $TOK" | \
    REPO="$repo" NUM="$num" DIR="$dir" ELAPSED="$elapsed" SID="$SID" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
call, verdicts = None, None
for e in d.get('events', []):
    p = e.get('payload', {})
    if p.get('type') == 'tool_start' and p.get('name') == 'review_report': call = p.get('args')
    if p.get('type') == 'tool_end' and p.get('name') == 'review_report': verdicts = (p.get('result') or {}).get('content')
print(json.dumps({'repo': os.environ['REPO'], 'pr': int(os.environ['NUM']), 'dir': os.environ['DIR'],
                  'sid': os.environ['SID'], 'seconds': int(os.environ['ELAPSED']),
                  'call': call, 'verdicts': verdicts}))
" >> "$OUT"
  echo "done $repo#$num"
done < "$HERE/ready.tsv"
