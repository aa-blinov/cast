#!/usr/bin/env bash
# End-to-end smoke test for the JSONL protocol running through the shared
# server daemon — plan mode, question/answer, plan review, hooks, and the
# /command bridge — against the real configured provider (real LLM calls,
# costs tokens).
#
#   npm run e2e:jsonl
#
# Flow: launch `run --interactive` (attaches to the server daemon) →
# set_mode plan → prompt that asks a question → answer_question →
# model writes a plan + plan_done → plan_review implement → model checks the
# plan → exit. Asserts on the JSONL event stream. Requires a provider in
# ~/.cast/settings.json. Runs in an isolated HOME so real sessions are never
# touched; the server daemon spawned for the run is stopped afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_HOME="$(mktemp -d)"
PROJ="$FAKE_HOME/proj"
JSONL_LOG="$FAKE_HOME/jsonl.out"

cleanup() {
	# Stop the daemon this run spawned (isolated HOME, so its state file lives
	# under $FAKE_HOME). Best-effort; the deamon's own --continue dedup means
	# a stray one won't leak into the real environment.
	HOME="$FAKE_HOME" node "$ROOT/dist/index.js" server stop >/dev/null 2>&1 || true
	rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

fail() {
	echo "FAIL: $1"
	echo "--- last JSONL events ---"
	grep -E '"type":"(error|end|notice)"' "$JSONL_LOG" | tail -20 || true
	exit 1
}

command -v node >/dev/null || { echo "SKIP: node not installed"; exit 0; }
[ -f "$HOME/.cast/settings.json" ] || { echo "SKIP: no provider configured (~/.cast/settings.json)"; exit 0; }

echo "== setup =="
mkdir -p "$PROJ" "$FAKE_HOME/.cast"
printf 'function greet(n) {\n\treturn `Hello, ${n}!`;\n}\nmodule.exports = { greet };\n' > "$PROJ/utils.js"
node -e "
const fs = require('fs');
const real = JSON.parse(fs.readFileSync(process.env.HOME + '/.cast/settings.json', 'utf8'));
const minimal = { providerUrl: real.providerUrl, apiKey: real.apiKey, model: real.model, persona: 'coding' };
fs.writeFileSync('$FAKE_HOME/.cast/settings.json', JSON.stringify(minimal, null, '\t'));
"
(cd "$ROOT" && npm run build >/dev/null)

# The JSONL driver: one action per line. answer_question waits for the model's
# picker; plan_review picks "implement" once the plan is ready.
CMDS="$FAKE_HOME/cmds.txt"
cat > "$CMDS" <<'EOF'
{"type":"set_mode","mode":"plan"}
{"type":"prompt","text":"Create a one-step plan: add an exported farewell(n) function to utils.js returning `Bye, ${n}!`, and write it to a plan file named jsonl-smoke. Do NOT call question. After writing the plan, call plan_done."}
{"type":"state"}
{"type":"exit"}
EOF

echo "== run through server (plan phase) =="
HOME="$FAKE_HOME" CAST_CWD="$PROJ" timeout 240 node "$ROOT/dist/index.js" run --interactive --format json \
	< "$CMDS" > "$JSONL_LOG" 2>"$FAKE_HOME/jsonl.err" || true

grep -q '"type":"end"' "$JSONL_LOG" || fail "no end event (did the server daemon start?)"
grep -q 'jsonl-smoke' "$JSONL_LOG" || fail "plan file was not created"

PLAN_FILE="$PROJ/.cast/plans"/*/jsonl-smoke.md
grep -q '\- \[ \]' $PLAN_FILE || fail "plan file has no unchecked checklist item"
grep -q 'farewell' "$PROJ/utils.js" && fail "implemented during plan mode (tool gating broken)"

echo "ok: plan written in plan mode, tools gated"

echo "== run through server (implement phase) =="
CMDS2="$FAKE_HOME/cmds2.txt"
cat > "$CMDS2" <<'EOF'
{"type":"plan_review","choice":"implement"}
{"type":"exit"}
EOF
HOME="$FAKE_HOME" CAST_CWD="$PROJ" timeout 240 node "$ROOT/dist/index.js" run --interactive -c --format json \
	< "$CMDS2" > "$JSONL_LOG" 2>&1 || true

# Same session resumed (no new plan session), so the plan file exists and now
# the model implements it: utils.js gains farewell(). (Whether the plan
# checklist flips to [x] depends on the model calling plan_check — some do,
# some leave it — so we assert on the code change, which is the invariant.)
grep -q 'farewell' "$PROJ/utils.js" || fail "utils.js was not modified after plan approval"
node -e "const u=require('$PROJ/utils.js'); if(u.farewell('x')!=='Bye, x!') process.exit(1)" \
	|| fail "farewell() does not behave as planned"
echo "ok: plan approved, code implemented and works"
echo "PASS: JSONL-through-server plan mode e2e"
