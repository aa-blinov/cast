#!/usr/bin/env bash
# End-to-end verification that hooks fire through the server daemon when a
# run attaches to it — SessionStart / UserPromptSubmit must execute against
# the daemon (which owns runAgentLoop), not the local runner. Real provider
# (costs tokens).
#
#   npm run e2e:hooks
#
# Runs in an isolated HOME (provider creds copied in, project marked trusted)
# so real sessions/settings are never touched. Asserts on a marker file the
# hooks write; the daemon spawned for the run is stopped afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_HOME="$(mktemp -d)"
PROJ="$FAKE_HOME/proj"
HOOK_FILE="$FAKE_HOME/hook.out"

cleanup() {
	HOME="$FAKE_HOME" node "$ROOT/dist/index.js" server stop >/dev/null 2>&1 || true
	rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }

command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }
[ -f "$HOME/.cast/settings.json" ] || { echo "SKIP: no provider configured (~/.cast/settings.json)"; exit 0; }

echo "== setup =="
mkdir -p "$PROJ/.cast" "$FAKE_HOME/.cast"
node -e "
const fs = require('fs');
const real = JSON.parse(fs.readFileSync(process.env.HOME + '/.cast/settings.json', 'utf8'));
fs.writeFileSync('$FAKE_HOME/.cast/settings.json', JSON.stringify({
  providerUrl: real.providerUrl, apiKey: real.apiKey, model: real.model,
  persona: 'assistant', projectTrust: { '$PROJ': true },
}, null, '\t'));
"
# cast-style hooks.json: HookMatcherGroup[] per event, each with a `hooks` array.
cat > "$PROJ/.cast/hooks.json" <<'EOF'
{
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo session_start >> $HOOK_FILE" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo user_prompt >> $HOOK_FILE" }] }]
}
EOF
(cd "$ROOT" && npm run build >/dev/null)

echo "== run through server =="
cat > "$FAKE_HOME/cmds.txt" <<'EOF'
{"type":"prompt","text":"reply with just: OK"}
{"type":"exit"}
EOF
HOME="$FAKE_HOME" CAST_CWD="$PROJ" HOOK_FILE="$HOOK_FILE" timeout 120 node "$ROOT/dist/index.js" run --interactive --format json \
	< "$FAKE_HOME/cmds.txt" > "$FAKE_HOME/run.log" 2>&1 || true

grep -q "session_start" "$HOOK_FILE" 2>/dev/null || fail "SessionStart hook did not fire (got: $(cat "$HOOK_FILE" 2>/dev/null || echo none))"
grep -q "user_prompt" "$HOOK_FILE" 2>/dev/null || fail "UserPromptSubmit hook did not fire (got: $(cat "$HOOK_FILE" 2>/dev/null || echo none))"
grep -q '"content":"OK' "$FAKE_HOME/run.log" || fail "model did not reply"

echo "ok: SessionStart + UserPromptSubmit hooks fired through the server daemon"
echo "PASS: hooks-through-server e2e"
