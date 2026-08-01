# Non-Interactive Mode

`cast run` sends a single prompt, streams the response to stdout, and exits. Designed for CI/CD, scripting, and piping.

For a persistent, machine-driven session, use `cast run --interactive`. It uses
the same startup and agent loop as the TUI and web UI, but exchanges JSONL
actions and state snapshots. This is the entry point for multi-step evals and
agents that need to inspect a pending picker before deciding what to do next.

## Usage

```bash
cast run "what changed in the last commit"
cast run --format json "list all TODO comments"
cast run -c "continue the refactoring"
cast run -m gpt-4o -r medium "explain the session module"
```

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
| `--bypass-permissions` | | Skip bash confirmation |
| `--skill <path>` | | Load extra skill |
| `--no-skills` | | Skip project/agents/global/plugin/builtin skill discovery |
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
includes the full visible transcript, model-facing context size, current mode,
pending question or plan review, and the active plan content.

```jsonl
{"type":"set_mode","mode":"plan"}
{"type":"prompt","text":"Plan a migration and ask questions first."}
{"type":"answer_question","values":["postgres","online"]}
{"type":"plan_review","choice":"clean"}
{"type":"prompt","text":"Run the migration tests."}
{"type":"exit"}
```

Actions are `prompt`, `set_mode` (`plan` or `build`), `answer_question`,
`plan_review` (`continue`, `implement`, or `clean`), `state`, and `exit`.
`answer_question` and `plan_review` run the next real turn when appropriate;
they do not fake UI state. `clean` retains the visible transcript while
starting implementation with a fresh model context.

## Exit Code

- `0` — success
- `1` — error (the `error` event contains the message)

## Examples

```bash
# Pipe JSON output to jq
cast run --format json "list files in src/" | jq 'select(.type == "token") | .text' -r

# Use in a CI pipeline
cast run --bypass-permissions "run the test suite and report failures"

# Resume and continue
cast run -c "now implement the changes we discussed"
```
