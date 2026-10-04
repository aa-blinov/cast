# Non-Interactive Mode

`cast run` sends a single prompt, streams the response to stdout, and exits. Designed for CI/CD, scripting, and piping.

For a persistent, machine-driven session, use `cast run --interactive`. It
connects to the same server daemon and agent loop as the TUI and web UI, but
exchanges JSONL actions and state snapshots. This is the entry point for
multi-step evals and agents that need to inspect a pending picker before
deciding what to do next.

## Usage

```bash
cast run "what changed in the last commit"
cast run --format json "list all TODO comments"
cast run -c "continue the refactoring"
cast run -m gpt-4o -r medium "explain the session module"
git diff | cast run "review this diff"        # no message: the prompt is read from stdin
cast run -- "-5 is a negative number"          # -- ends the options, so the message may start with a dash
```

The prompt comes from stdin only when there is no message (or the message is `-`); a script that passes a message
and leaves stdin open never waits on it.

## On a machine with nothing configured

`cast run` uses the provider saved in `~/.cast/settings.json`, so a fresh CI container needs one. Write the file
before the first run (the directory is created on demand):

```bash
mkdir -p ~/.cast
cat > ~/.cast/settings.json <<EOF
{ "providerUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY", "model": "openai/gpt-4o" }
EOF
cast run "run the test suite and report failures"
```

Without a provider the run fails in a few seconds with `No provider is configured` and exit code 1. The first run
starts the shared daemon (a few seconds); later ones reuse it.

## Output Formats

### Default

Human-readable output streamed to stdout:

- Assistant text → stdout
- Tool names → stderr (`  bash...`)
- Tool errors → stderr (`  bash failed: ...`)
- Doom loop warnings → stderr

### JSON

```bash
cast run --format json "analyze this codebase"
```

Structured JSON events, one per line (JSONL). Each event has:

```json
{
  "type": "token",
  "timestamp": 1720000000000,
  "sessionID": "nd4k8f2x",
  "text": "Hello"
}
```

### Event Types

| Type | Fields | Description |
|------|--------|-------------|
| `token` | `text` | Streaming text chunk |
| `thinking` | `text` | Reasoning/thinking content |
| `assistant_message` | `content`, `toolCalls` | Complete assistant message |
| `tool_start` | `id`, `name`, `args` | Tool execution started |
| `tool_end` | `id`, `name`, `result` | Tool execution completed |
| `doom_loop` | `tool`, `attempts` | Tool blocked after identical calls |
| `usage` | `usage`, `subagent` | Token/cost usage update |
| `end` | `reason` | Run completed (`stop`, `error`, etc.) |
| `error` | `message` | Error occurred |

For an unsuccessful `tool_end`, `result.error` is a stable object for clients:
`code`, `retryable`, and `suggestedFix`. The human-readable `result.content`
remains available for the precise diagnostic; clients should use the structured
fields instead of parsing that text.

## Flags

`cast run` accepts a subset of the main CLI flags:

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Continue the most recent session |
| `--session <id>` | `-s` | Continue a specific session |
| `--model <model>` | `-m` | Model to use |
| `--reasoning <level>` | `-r` | Reasoning level |
| `--persona <name>` | `-p` | Persona to use |
| `--format <default\|json>` | | Output format |
| `--interactive` | | Persistent JSONL session protocol (no positional message) |
| `--bypass-permissions` | | Skip confirmations (alias `--dangerously-skip-permissions`) |
| `--skill <path>` | | Load extra skill |
| `--no-skills` | | Skip project/agents/global/builtin skill discovery |
| `--mcp <path>` | | Load extra MCP config |
| `--no-mcp` | | Skip MCP discovery |

The message is everything after the flags (no quoting required for single words, but shell quoting helps for multi-word messages).

## Plan Mode

Plan tools are not available in non-interactive mode. However, if you resume a session that has an approved plan (`cast run -c "..."`), the plan is injected into the build-mode system prompt to steer implementation.

## Persistent JSONL Sessions

```bash
cast run --interactive
```

Send one JSON object per line on stdin. Cast emits the normal streaming JSON
events plus a `state` snapshot at startup and after every action. The snapshot
includes the visible transcript (`messages`), current `mode` and `status`,
pending `question` or `planReview`, and the session `cwd`.

```jsonl
{"id":"1","type":"set_mode","mode":"plan"}
{"id":"2","type":"prompt","text":"Plan a migration and ask questions first."}
{"id":"3","type":"answer_question","values":["postgres","online"]}
{"id":"4","type":"plan_review","choice":"clean"}
{"id":"5","type":"prompt","text":"Run the migration tests."}
{"id":"6","type":"abort"}
{"id":"7","type":"exit"}
```

Actions are `prompt`, `set_mode` (`plan` or `build`), `answer_question`,
`plan_review` (`continue`, `implement`, or `clean`), `command`, `shell`
(`{"type":"shell","command":"git status"}` runs it for you, with no model turn; see
[`!`](interactive-commands.md#running-a-shell-command-)), `state`, `abort`, and `exit`. `answer_question` and `plan_review` run the next real turn when
appropriate; they do not fake UI state. `clean` retains the visible transcript
while starting implementation with a fresh model context.

- **Order.** Actions run one at a time, in the order they were sent; a `prompt` finishes (and its `state` is emitted)
  before the next action starts. `abort` is the exception: it is read while a turn runs and stops it at once, and the
  `prompt` it interrupted completes with the usual `end` event (reason `aborted`).
- **Ids.** An optional `id` (string or number) on an action comes back on its `action_done` event, or on the `error`
  event when it failed, so a client with several actions in flight can match replies. `action_done` carries `action`
  and `ok`; it means the action finished. A turn that failed also sends its `error` event before the `action_done`.
- **Bad input** (malformed JSON, an unknown action, a missing field) is an `error` event, and the session carries on.
  Blank lines are ignored.
- **End.** `exit`, or stdin closing, ends the session after the actions already sent have finished; the process then
  exits `0`. SIGINT, SIGTERM and SIGHUP abort the turn and exit `130`, `143` and `129`.
- **Connection.** If the daemon connection drops while a turn runs, the action fails with an `error` event instead
  of being reported as finished.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | The turn finished (`stop`), or was aborted |
| `1` | The run failed: an `error` event, a turn that ended early (`error`, `disconnected`, ...), the daemon connection dropping mid-turn, an unknown session id, `-c` with no session to continue |
| `2` | The command was written wrong: an unknown option, a flag without its value, a bad `--format` or `-r`, an unknown persona, no message. Nothing was sent to the model |
| `129` / `130` / `143` | Stopped by SIGHUP / SIGINT / SIGTERM |
| `141` | The reader closed stdout (`cast run ... | head -1`) |

Every error is one line on stderr (`cast run: ...`), not a stack trace.

## Stopping a run

The turn runs in the daemon, so `cast run` stops it itself: on SIGINT, SIGTERM or SIGHUP, or when stdout is closed, it
aborts the turn (and kills the background tasks it started), then exits with the code above. `timeout 300 cast run ...`
therefore leaves nothing running behind. A second signal exits at once.

## Examples

```bash
# Pipe JSON output to jq
cast run --format json "list files in src/" | jq 'select(.type == "token") | .text' -r

# Use in a CI pipeline
cast run --bypass-permissions "run the test suite and report failures"

# Resume and continue
cast run -c "now implement the changes we discussed"
```
