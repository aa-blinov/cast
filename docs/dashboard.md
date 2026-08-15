# Dashboard

The dashboard is a web-only analytics view of the running cast daemon: LLM
usage and cost, endpoint performance, error/reliability signals, and
system-level activity (compactions, turns, tool usage, memory maintenance).
It reads from the telemetry tables in `~/.cast/sessions/sessions.db` — the
same database that holds sessions — and never makes provider calls itself.

## Opening the dashboard

- Open the web UI (`cast web`, then visit `http://localhost:1337`) and click
  the chart icon in the header.
- Or go straight to the dedicated route: `/dashboard`. The dashboard has its
  own URL and survives browser back/forward. The `?session=<id>` query rides
  along, so a dashboard link keeps its session context and returning to `/`
  reconnects the same session.

Every tab has a time range selector: **24h / 7d / 30d**. Charts and tables
re-render on range change; nothing is client-side mock data.

## Tabs

### LLM

Per-LLM-request metrics over the selected window:

- **KPIs**: Requests, Prompt tokens, Completion tokens, Cost, Cache rate
  (cached/total prompt %), Latency avg, **p50 / p95 / p99** decode latency,
  Tokens/s (throughput), Errors.
- **Charts**: "Requests & latency" and "Tokens" over time, plus a
  "By provider & model" breakdown.
- **Recent requests** table (paginated): time, kind, provider, model, tokens
  in/out, cache, latency, error.

One row per LLM completion. A single user turn spans several rows; rows are
grouped by `turn_id` (the client message id) for the System tab's per-turn
metrics. Retry and error rows are not counted as requests (they appear in
Reliability instead), so there is no double counting.

### Memory

Activity of cast's durable memory system:

- **KPIs**: `memory` tool (search) calls, search errors, average search
  latency, maintenance runs, **entries stored** (dream + distill writes),
  maintenance tokens.
- **Automatic maintenance runs** table: kind (dream/distill), status
  (completed/failed), runs.

Search metrics come from `tool_calls`; maintenance metrics come from the
`memory_maintenance` table, recorded at each automatic dream/distill pass.

### Performance

The daemon's own HTTP surface:

- **KPIs**: Requests, Avg latency, **p50 / p95 / p99**, Worst latency,
  5xx errors.
- **Endpoint requests & latency** chart and an **Endpoints** table: method,
  path, requests, avg/worst ms, 5xx count.

One row per `/api/*` request. Telemetry reads (`/api/telemetry/*`) and SSE
event streams are excluded so the data isn't polluted.

### Reliability

Failure and retry signals:

- **KPIs**: Requests, Retries, Retry rate, Moderation blocks.
- **Errors & retries by type** bar chart and an **Error & retry breakdown**
  table.

Error types include the usual taxonomy (moderation, quota, upstream,
rate-limit, auth, context overflow) plus harness-specific ones: **doom-loop**
(repeated identical failing tool calls) and **empty-response** (a retried
turn that came back empty).

### System

Activity that isn't an LLM completion:

- **KPIs**: Compactions, Context saved (tokens), Avg context use (prompt
  tokens + % of window), Sessions, File edits (write + edit calls), **Turns**
  (user requests), **Tool calls/turn**, **Tokens/turn**, **Time/turn**.
- **Tool calls** chart (calls vs errors) and a **Tool usage** table: tool,
  calls, errors, avg latency.

A "turn" is one user request with its series of completions and tool calls,
grouped by `turn_id`. Turn duration is the span from the first to the last
completion in the turn (includes tool execution between them).

## What's measured and what isn't

- Requests/cost/tokens/cache come from `llm_requests`; latency is decode time
  (`generationMs`), TTFT is tracked but only latency percentiles are shown.
- Background maintenance (automatic memory dream/distill and the checkpoint
  writer) is recorded as `kind = background` rows, distinct from main and
  subagent usage.
- Background tasks never started by a user turn are included; telemetry's own
  reads and long-lived SSE connections are excluded from Performance.
- Cost shows as `—` when the provider doesn't report it (e.g. MiniMax).
