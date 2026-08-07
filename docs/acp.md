# ACP — Agent Communication Protocol

`cast acp` exposes cast as a JSON-RPC 2.0 agent over stdio, using
`@agentclientprotocol/sdk` for transport and schema. Any editor that
speaks ACP (zed, JetBrains, Neovim via an ACP plugin) can drive cast
as the underlying agent.

## Quickstart

```sh
cast acp --cwd /path/to/project
```

The process reads JSON-RPC on stdin and writes to stdout. It runs until the
client closes stdin (EOF), sends a `cancel` notification, or the process
is terminated.

## CLI flags

```
cast acp [--cwd <path>] [--session <id>] [--continue] [--bypass-permissions]
  --cwd <path>        Project root for the new session.
  --session <id>      Resume an existing session by id.
  --continue          Resume the most recent session in --cwd.
  --bypass-permissions  Auto-approve all bash confirmations.
  --help              Show this help.
```

## Implemented methods

| Method                | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `initialize`          | Negotiate protocol version + advertise capabilities.          |
| `authenticate`        | No-op (cast has no auth flow; returns empty `{}`).             |
| `session/new`         | Create a session in the given cwd.                              |
| `session/load`        | Re-open an existing session by id.                             |
| `session/list`        | List all sessions in the local database.                       |
| `session/close`       | Close a session and abort its runner.                          |
| `session/resume`      | Resume an existing session (same as load).                     |
| `session/set_mode`    | Toggle plan/build mode.                                         |
| `session/prompt`      | Submit a turn; mid-turn prompts enqueue on `steeringQueue`.    |
| `session/cancel`      | Abort the in-flight run.                                       |

## Capabilities

Advertised in `initialize`:

```json
{
  "loadSession": true,
  "promptCapabilities": { "audio": false, "embeddedContext": true, "image": true },
  "mcpCapabilities": { "http": false, "sse": false },
  "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
}
```

- `forkSession` is advertised but returns an empty result (no fork support yet).
- `mcpCapabilities.{http,sse}` are `false` — cast consumes MCP, doesn't expose it.
- `promptCapabilities.image` is `true` because cast supports image attachments.

## Notifications the agent sends

| Method                | Payload                                                       |
| --------------------- | ------------------------------------------------------------- |
| `session/update`      | One per `AgentEvent` — `agent_message_chunk`, `tool_call`,     |
|                       | `tool_call_update`, `agent_thought_chunk`, `usage_update`,     |
|                       | `session_end`, `session_error`, plus `info` for internal      |
|                       | signals (compaction, todos, doom-loop, retry).                 |
|                       | `usage_update` payload includes `used`, `size` (context        |
|                       | window in tokens), and `cost: { amount, currency }` (cumulative |
|                       | session cost in USD, summed across all `usage` events).        |
| `request_permission`  | Sent via `session/request_permission` request from the agent   |
|                       | to the client. Reply arrives as a typed `RequestPermissionResponse`. |
| `request_question`    | One per plan-mode question, with the questions and their options. |
|                       | Reply via `answer_question` (custom extension method).         |
| `request_plan_approval` | One per plan-mode transition (plan ready / approved). Reply   |
|                       | via `plan_review` (custom extension method).                  |
| `available_commands_update` | Sent once on session creation, lists all slash commands.   |
|                       | `name` is the command verb (e.g. `compact`, not `/compact`);   |
|                       | `input.hint` is set on commands that take arguments.            |

## Dependencies

`cast acp` requires `@agentclientprotocol/sdk` at runtime — it's declared
as a direct dependency in `package.json`.

## Behavior parity with the TUI

ACP mode reuses the same `runStartup` → `runAgentLoop` → `AgentRunner`
machinery the TUI uses. The bridge replaces:

- `confirmBash` → `requestPermissionViaBridge` (or `undefined` in bypass mode).

Everything else — tool gating, plan state, subagent tools, hooks, skills,
compaction — is shared. Mid-turn prompts behave identically: enqueued on
`runner.followUpQueue`, consumed at the next inner-loop iteration.

## Limitations

- ACP MCP-server mode is not implemented.
- ACP filesystem `resources` (read/write API) is not implemented.
- ACP terminal mode (`terminal/*`) is not implemented.
- `forkSession` / `setSessionConfigOption` / `setSessionModel` are not implemented.
- `authenticate` returns `{}` — no auth flow.
- `providers/list`, `logout`, `nes/*` not implemented.
- Slash commands are advertised via `available_commands_update`, but invoking
  them requires sending text through `session/prompt` — there is no
  command-specific protocol method.

## Smoke test

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<id>","prompt":[{"type":"text","text":"hi"}]}}' \
  | cast acp --bypass-permissions 2>&1 | head -n 50
```

Expected: `initialize` result with `agentCapabilities`, `session/new` result
with `sessionId`, then a stream of `session/update` notifications.
