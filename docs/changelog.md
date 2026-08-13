# Changelog

All notable user-facing changes to cast, newest first.

## 0.15.5

### Fixed

- **Concurrent turns are serialized reliably.** TUI, Web UI, and separate Cast processes now claim a session before starting work, preventing duplicate agent loops, interleaved history, and stale cleanup from releasing a newer turn.
- **Web message retries are idempotent across reconnects.** Client message identifiers, pending-message recovery, and ordered SSE updates keep prompts visible without creating duplicate turns.

### Internal

- **Tests now run inside per-test environments.** Each test gets an isolated home, cwd, settings file, SQLite database, and daemon state; custom database paths create their parent directories automatically.

## 0.15.4

### Fixed

- **The landing page removes redundant explanatory chrome.** Install commands now have accessible copy buttons with the Web UI's project icon style, and the footer is reduced to quiet GitHub and MIT License links.

## 0.15.3

### Fixed

- **The landing workspace preview now keeps its top bar focused on connection state.** Removed the repeated product and repository labels, matched the connected status dot to the Web UI, and removed the duplicate persona/build footer.

## 0.15.2

### Fixed

- **Landing and documentation chrome is cleaner and consistent on mobile.** Removed redundant workspace labels, session/model status noise, and repeated persona cards; themed scrollbars now apply to the Pages document and its scrollable content areas.

## 0.15.1

### Fixed

- **GitHub Pages workspace preview now matches the actual Web UI structure.** Removed the misleading local-first badge, fabricated capability metrics, and empty composer; the preview now shows the real header, sessions sidebar, chat state, and interactive persona switching.

## 0.15.0

### Added

- **The GitHub Pages landing page is now a Cast workspace overview.** It presents the session flow, personas, capabilities, installation commands, and documentation in a responsive desktop/mobile layout.
- **Documentation code blocks now have build-time syntax highlighting.** Language labels, readable dark-theme tokens, and horizontal scrolling make shell, JSON, Markdown, and other examples easier to scan on any screen.

## 0.14.0

### Added

- **Settings now has a Personas browser.** Personas are grouped by source, with the existing info popover for short descriptions and the book action for reading the full persona prompt.

## 0.13.37

### Fixed

- **Web thread pagination now explains its state at the top of the transcript.** Older-message loads show a visible loader, failures offer retry, and reaching the beginning is labeled explicitly.

## 0.13.36

### Fixed

- **Release archives now contain only the native PTY runtime for the detected platform and architecture.** Installers select Linux, macOS, and Windows x64/arm64 assets, while old releases remain installable through a safe legacy fallback.

## 0.13.35

### Fixed

- **Session lists no longer parse every assistant message to count tool calls.** Tool-call metadata is stored in an indexed SQLite flag, including a migration for existing databases, reducing list queries as history grows.

## 0.13.34

### Fixed

- **Web messages no longer disappear during session startup or reconnects.** Chat waits for the active SSE stream before dispatching, keeps unacknowledged messages visible for retry, and rehydrates accepted messages when the stream is delayed.
- **Message retries are idempotent.** A client message id prevents a lost HTTP response or reconnect from creating a duplicate turn.

## 0.13.33

### Fixed

- **Release archives include the native PTY runtime.** `cast upgrade` now installs `node-pty` and its native dependency alongside the bundle, so managed Bash background tasks work after a clean upgrade.

## 0.13.32

### Added

- **Long-running Bash commands can move to the background without a handoff.** Interactive TUI and web sessions now run managed Bash tasks through PTY, automatically promote known server/watcher commands or foreground commands that exceed their grace period, and report the task id for progress and control.

### Changed

- Updated Bash tool documentation and shared persona guidance for automatic background promotion, completion reminders, `bash_output`, and `bash_kill`.

## 0.13.31

### Fixed

- **Provider list now disambiguates entries that share a base URL.** When two saved providers pointed at the same host with different API keys, the web UI silently treated the first one as active (the save ✓ never disabled, the chat footer showed the wrong name, and `/provider list` marked both as active). Lookup now matches by name (falling back to URL + key), and the provider row in Settings shows a green "active" badge for the one in use.

## 0.13.30

### Fixed

- **TUI recovers across daemon upgrades and restarts.** Stale daemon connections now time out, reconnect to the current daemon, retry the message, and restore the session state over SSE.
- **Web chat no longer loses the first message during SSE startup.** A draft waits briefly for its active session stream, with bounded recovery when the daemon is temporarily unavailable.

## 0.13.29

### Fixed

- **Provider, model, and reasoning changes now stay synchronized.** TUI and Web UI selections apply atomically, cancel safely, normalize unsupported reasoning levels for the selected model, and persist across daemon turns and browser reloads.
- **Cross-surface model changes now take effect immediately.** A model or provider changed in another client is picked up on the next turn without stale model metadata or transport settings.

## 0.13.28

### Fixed

- **Provider and model selections now persist together.** TUI and Web UI provider switches update the main model provider, repair stale provider settings, and safely fall back when an active provider is removed.

## 0.13.27

### Fixed

- **Daemon TUI now handles injected queue events.** Follow-up and steer messages are added to the transcript and removed from the pending list when the daemon injects them, instead of remaining stuck as `Queued`.

## 0.13.26

### Fixed

- **Follow-up handoff now waits for the runner's idle signal.** TUI and daemon clients no longer depend on the timing of status or SSE events to start a queued request.

## 0.13.25

### Fixed

- **Local TUI follow-ups no longer remain stuck as `Queued`.** Messages that arrive while a turn is settling are picked up and run after the current response completes.

## 0.13.24

### Fixed

- **`cast upgrade` now reports the final daemon state.** After restarting a background daemon, the command verifies its new PID and identity, prints the running URL, and exits unsuccessfully if the replacement could not be confirmed.

## 0.13.23

### Fixed

- **Late daemon follow-ups now start reliably.** A `/queue` or Web UI follow-up that arrives while the previous turn is settling is handed to a new turn instead of remaining stuck as `Queued`.

## 0.13.22

### Fixed

- **Resource commands now use subcommand-aware daemon gating.** Read-only `/mcp`, `/skills`, and `/ssh` inspection remains available during a turn, while operations that change tools, skills, or SSH configuration wait until the turn is idle.

## 0.13.21

### Fixed

- **Daemon follow-up messages no longer get stranded.** Queue requests that arrive just after a turn finishes now start a new turn, so `/queue` and the Web UI follow-up action remain reliable across the daemon API.

## 0.13.20

### Fixed

- **First-run daemon startup no longer fails without provider credentials.** The daemon starts in setup mode and clearly directs users to configure a provider in the Web UI or use the terminal onboarding through `cast`.

## 0.13.19

### Fixed

- **Daemon restarts no longer create empty sessions.** The startup-only session used to select defaults is no longer persisted, preventing one empty SQLite record from accumulating for every daemon restart.

## 0.13.18

### Added

- **Stable API v1 for daemon integrations.** Alternative clients can now use the versioned `/api/v1` REST/SSE contract for session lifecycle, agent control, history, files, settings, and daemon metadata without depending on private web UI routes.
- **Published OpenAPI specification.** Every daemon serves `/api/v1/openapi.json`; GitHub Pages publishes the matching checked-in snapshot at `openapi/v1.json` for code generation and CI validation.

### Fixed

- **API input failures are explicit.** Malformed JSON and invalid appearance, SSH, or provider-verification fields return actionable `400` responses rather than leaking through as server errors.

## 0.13.17

### Fixed

- **Interrupted file searches stop immediately.** `/abort` now cancels in-flight `glob` and `grep` processes (`fd`/`rg`) and their built-in fallback scans instead of allowing a search to continue after the turn was cancelled.
- **Tool failures have a stable recovery contract.** Every failed tool result now includes an error code, whether retrying is appropriate, and a suggested fix alongside its readable diagnostic. This is carried through the agent loop, SSE, and JSONL clients.
- **Daemon abort recovery is covered end-to-end.** A daemon session that aborts a stalled provider request reliably returns to idle and can start another turn.

## 0.13.16

### Fixed

- **Tool failures now tell the agent how to recover.** Invalid arguments for filesystem, shell, SSH, search, and web tools are rejected before execution with the specific field and valid replacement range. Missing search paths are no longer reported as empty results.
- **Destructive MCP calls now request write approval.** The confirmation gate now recognizes Cast's real `mcp_<server>_<tool>` names, including when hooks are enabled.
- **Failed background commands stay failed.** `bash_output` now preserves timeout and non-zero-exit errors instead of displaying an `ok` status; bash and SSH also explicitly mark byte-truncated output.
- **MCP and cancellation errors have actionable context.** MCP failures identify the server and tool, while interrupted web requests are labelled `[ABORTED]` rather than as generic network failures.

## 0.13.15

### Changed

- **`cast web` is the primary browser entry point again.** `cast server` remains a fully equivalent alias for daemon-oriented scripts and integrations, so either spelling manages the same daemon and sessions.

### Fixed

- **Daemon lifecycle is safe across restarts and upgrades.** Cast now verifies the daemon's per-process identity before attaching to it or signalling its PID, so a stale state file cannot direct a client to — or stop — an unrelated process that reused the PID.
- **Upgrades preserve a background daemon's address.** `cast upgrade` restarts a verified background daemon on its existing host and port only after it exits cleanly. Foreground daemons are left untouched for their owning terminal to restart manually, preventing an automatic upgrade from cutting off active work.
- **Long-lived daemons release inactive sessions without losing them.** Idle sessions with no listeners and no active background task are unloaded after five minutes and rehydrated on demand; reconnecting clients recover authoritative pending state and report rejected control commands instead of silently losing them.

## 0.13.14

### Fixed

- **Opening a second `cast` while another was already running no longer strands the first on a dead daemon.** Two concurrent launches used to race on the empty state file and each spawn its own daemon; the one that lost the race was never registered, and a TUI already pointed at it reported "Daemon unreachable" on its next message. Daemon startup is now serialized by an exclusive lock — concurrent launches wait and reuse the winner instead of stacking a second process.
- **An idle TUI now survives its daemon being replaced.** If the daemon is stopped, crashes, or is restarted by an upgrade, the next message in the open TUI re-reads the daemon state, reconnects to the new daemon, and retries — the session (owned by the central store) continues instead of erroring.

## 0.13.13

### Added

- **Live agent events are now persisted for audit/debug.** Tool runs, retries, doom-loop stops, compaction failures, errors, and turn ends land in a new `session_events` table (readable via `GET /api/sessions/:id/events/history`). These are execution telemetry, deliberately kept out of the conversation history so the model never sees them as context.
- **Versioned database migrations.** Schema changes are now an ordered, tracked migration list (`schema_migrations` table) applied once each inside a transaction — the standard Flyway-style pattern — replacing the previous ad-hoc column checks. Existing databases migrate in place without losing any sessions or messages.

## 0.13.12

### Fixed

- **Stale `cast web` no longer becomes a phantom message.** Upgrading from a pre-0.13.11 install (`cast upgrade` from 0.13.9 or older) used to restart the daemon via `cast web start --port 0`. Since the command was renamed to `cast server`, the new binary read `web start --port 0` as a TUI prompt instead of a subcommand — a phantom `[user] web start --port 0` message landed in a fresh session. `cast web` now prints a clear "renamed to cast server" error instead of falling through to the prompt.

## 0.13.11

### Changed

- **`cast web` is now `cast server`.** The daemon was the single-writer backend every surface talks to, not just the web UI, so the name was misleading. The command, state file (`server.json`, auto-migrated from `web.json`), env vars (`CAST_SERVER_*`), and the settings key (`serverToken`, auto-migrated from `webPassword`) are all `server` now. The web UI is unchanged — it's just served by the `cast server` daemon. `cast web` is no longer accepted.
- **The daemon is persistent and single-instance.** It stays up after the TUI exits so background processes keep running and the web UI stays reachable; repeated `cast`/`npm start` reuse the one running instance instead of stacking orphaned processes.
- **`cast run` and `cast run --interactive` now go through the same server daemon** as the TUI and web UI. Sessions land in the shared store, `-c`/`-s` resume works, and JSONL commands (including `/worktree`, plan review, question answers) round-trip through the server's command surface.

### Added

- `Ctrl+L` clears the composer in any state; idle `Esc` no longer wipes typed text (a stray press used to delete your message).
- E2E harness for the server paths: `npm run e2e:jsonl` (plan mode through the daemon) and `npm run e2e:hooks` (hooks firing on the daemon).

### Fixed

- Stopping a running turn now needs a deliberate double-`Esc`; a single stray `Esc` no longer kills a long in-flight turn.
- The ASCII banner no longer disappears ~0.5 s after startup (a settle resync cleared it).
- Exiting is clean: no `^[[15;1R`-style cursor-query garbage in the shell, and the last TUI frame is cleared.
- The question picker names exactly which option is missing its required `value`, so the model knows what to fix.
- Older session history loads a page at a time (`/older` or `PageUp`) instead of flooding the terminal scrollback on resume.

## 0.13.10

### Added

- **Older session history is paged instead of dumped.** Resuming a long session no longer floods the terminal scrollback with the whole transcript (which pushed the viewport past the buffer limit and made the start unreachable). Only the most recent turns load; `/older` or `PageUp` loads more on demand.
- **`Ctrl+L` clears the composer in any state.** Idle `Esc` used to wipe typed text — a stray press deleted your message. Clearing now lives on `Ctrl+L` only, and `Esc` is reserved for stopping a running turn.

### Changed

- **Stopping a turn needs a deliberate double-`Esc`.** The first press shows `[Press Esc again to stop the turn]`; a second within 2 s aborts. A single stray `Esc` no longer kills a long in-flight turn.

### Fixed

- **The banner no longer disappears after startup.** `settleResync` (added in 0.13.7) cleared the screen ~0.5 s after mount, erasing the ASCII banner and composer frame because the banner lives outside Ink's tree. Light resyncs now reprint it.
- **Clean exit: no terminal garbage after quitting.** A pending cursor-position query (`\x1b[6n`) could have its reply echoed into the shell once raw mode dropped (`^[[15;1R` etc.). Exiting now cancels the query, stops polling, and clears the screen.
- **The question picker reports exactly what's wrong.** When a model omits an option's required `value` field, the error now names the offending option instead of a generic count message.

## 0.13.9

### Fixed

- **Text-only models stop receiving image attachments.** When a provider rejects `image_url` message parts (e.g. deepseek-v4-pro on a text-only endpoint), the rejected image messages are now removed from the session — previously they stayed and every turn re-sent them, failing again. Models that don't support images now just see the file path.

## 0.13.8

### Fixed

- **Raw mode is re-asserted if the terminal drops it.** Some terminals / SSH wrappers quietly restore echo and line buffering, which made typed text appear below the composer frame instead of entering it. A 2 s watchdog re-enables raw mode whenever it's detected as off.

## 0.13.7

### Fixed

- **Resumed sessions re-settle the layout.** Opening an existing session replays its history, which could scroll the composer up mid-screen (input landing below the frame) with no streaming turn to trigger the usual repair. A light resync now runs shortly after mount to reposition the composer at the bottom.

## 0.13.6

### Fixed

- **A stacked display (composer rendered above the input) is now corrected.** When DECXCPR scroll detection was unavailable, the cleanup resync never fired and the mis-rendered layout persisted; the resync now proceeds even without scroll detection, so the display self-heals.

## 0.13.5

### Fixed

- **`cast upgrade` now restarts a running daemon.** Previously it replaced the binary but a live `cast web` daemon kept executing the old bundle until manually restarted, so fixes never reached the daemon process. If a daemon is running at upgrade time it's now stopped and restarted on the new build.

## 0.13.4

### Fixed

- **DECXCPR scroll-polling stops if the terminal never answers.** A terminal that echoes the query instead of delivering it (raw mode lost, e.g. on resume) used to keep re-echoing garbage on every poll — now the poll gives up after the first unanswered query, so the flood can't recur even on a hostile terminal.

## 0.13.3

### Fixed

- **Composer input no longer goes dead on terminals that answer the DECXCPR scroll-poll slowly.** The poll attached a temporary stdin listener per query, which swallowed keystrokes for up to 400 ms a time; the response is now detected through the composer's own input pipeline, and the poll skips terminals that aren't actually in raw mode.

## 0.13.2

### Fixed

- **DECXCPR scroll-poll responses no longer leak into the composer.** The terminal's cursor-position replies (echoed while stdin drops out of raw mode, e.g. during a bash tool) used to land as visible garbage like `^[[67;1R` or `68;1R` in the input buffer. In-flight queries are now cancelled the moment the terminal suspends, and stray response remnants are dropped defensively.

### Internal

- `turn-runner-state` tests now write their sentinel files behind a fake HOME, so a killed test run can never pollute the real `~/.cast/sessions/`.

## 0.13.1

### Fixed

- **Abort is always responsive.** Esc cancels a provider retry backoff immediately (no more waiting out a 30 s sleep); the OpenAI SDK's own uninterruptible retries are disabled (`maxRetries: 0`); a parallel tool batch closes after a 2 s grace even when a tool (e.g. a hung MCP server) ignores the abort signal — the turn always lands on "aborted".
- **Turn errors stay in the transcript.** A 4xx failure is committed to the chat history instead of sticking above the composer until the next turn.
- **Question picker and plan/build mode work in the daemon-mode TUI.** The question picker opens and answers go back over HTTP; `/plan`, `/build`, and the plan-approval dialog sync the mode to the `cast web` daemon so the next turn actually runs in the chosen mode.
- **Provider/model switches take effect without a restart.** A running `cast web` daemon picks up settings.json changes (made in the TUI or by hand) at the next turn, and reconciles a stale session model against the new provider's model list.
- **Image files attach inline.** Pasting (Ctrl+V) or attaching (Ctrl+G) an image path sends the image to the model as a real attachment instead of a bare path it must `read`.
- **Provider retries surface in the web UI** as a `[Retrying (attempt N)…]` row instead of a silent spinner.
- **Undo checkpoints and subagent transcripts are persisted** to the session database, so `/undo` history and subagent work survive a daemon restart.

### Added

- **ACP permission flow via the SDK.** `requestPermissionViaBridge` now sends a typed `session/request_permission` request to the client (with `Promise.race` timeout of 60 s), instead of emitting a custom `request_permission` notification that the client couldn't reply to. The reply is the typed `RequestPermissionResponse` — `outcome.outcome === "selected"` with `optionId === "allow_once"` grants, anything else denies.
- **Plan-mode pickers.** `onPendingStateChange` wired through `createPlanState` — plan questions now surface as `request_question` notifications, plan transitions as `request_plan_approval`. Two custom extension methods (`answer_question`, `plan_review`) accept replies and resolve the pending state.
- **`tool_call.kind`** mapped to ACP constants: `bash` → `execute`, `read` → `read`, `write`/`edit`/`patch` → `edit`, `grep`/`glob`/`web_fetch`/`web_search` → `search`. Previously every tool reported its own name as the kind.
- **`available_commands_update`** sent once on session creation with the full slash-command list (`SLASH_COMMANDS` from `src/ui/commands.ts`). Names are stripped of leading `/` to match ACP conventions; `input.hint` is set on commands that take arguments.
- **`usage_update` with full payload.** Now sends `{ used, size, cost: { amount, currency } }` per ACP spec — `used` is the current turn's token count, `size` is the model's context window, `cost` is the cumulative session cost in USD summed across all `usage` events.
- **Multi-modal content in `session/prompt`.** ACP v1 `PromptRequest.prompt[]` accepts text, image, audio, and resource blocks. `text` is forwarded as-is, `image` (base64 + mimeType) is converted to an `image_url` data URL and passed through cast's existing vision path (`runAgentLoop` already strips unsupported image_url parts — see `loop.ts:1173`). Audio and resource blocks are dropped with a marker note (cast has no audio/embedded-resource ingestion path through ACP yet).
- **`session/load` and `session/resume` replay history.** When a client opens an existing session, the bridge re-emits every persisted user/assistant message as `user_message_chunk` / `agent_message_chunk` notifications in chronological order, so the editor sees the conversation history. Replay is fire-and-forget — the `session/load` response is returned immediately.

### Changed

- **ACP bridge migrated to `@agentclientprotocol/sdk`.** The `cast acp` wire transport is now powered by the official SDK (v1.3.0, zero dependencies, Apache-2.0) — all JSON-RPC serialization, schema validation, and protocol negotiations are handled by the library. The hand-rolled `rpc.ts` / `types.ts` / `handler.ts` / `tools.ts` / `index.ts` (≈600 lines) have been replaced by `agent.ts` (the typed `acp.agent({ name: "cast" })` factory + handler registration) and `bridge.ts` (the cast-side adapter that translates `AgentEvent` into SDK `sessionUpdate` notifications and routes SDK requests into `runAgentLoop`). Method names now use the slash-separated protocol convention (`session/new`, `session/load`, `session/prompt`, `session/set_mode`, `session/cancel`, `session/close`, `session/resume`, `session/list`, `authenticate`). The old `tools/list`, `permission/grant`, `permission/deny`, `answer_question`, and `plan_review` methods have been dropped — `tools/list` was never an ACP spec method, and the plan/picker bridge (`request_question`, `request_plan_approval`) is deferred to a future iteration.
- **Expanded agent capabilities.** `agentCapabilities` now advertises `promptCapabilities: { audio: false, embeddedContext: true, image: true }`, `mcpCapabilities: { http: false, sse: false }`, `sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} }` — matching the structured shape editors expect instead of the previous flat boolean set.
- **New ACP methods.** `authenticate` (returns empty `{}`), `session/list`, `session/close`, and `session/resume` are now registered on the SDK agent. `session/list` reads from the SQLite session database and returns `{ sessionId, cwd, title }`. `session/close` deletes the session and aborts its runner.

## 0.13.0

### Added

- Single-writer daemon architecture: `cast web` is now the one process that owns `runAgentLoop` and is the only writer to the SQLite session store. The TUI (`cast`, no subcommand) is a thin client of it over HTTP + SSE instead of running the loop locally — on launch it auto-spawns the daemon on loopback (reusing one if already running) and renders from the same `/api/sessions/:id/events` stream the browser uses. A session opened in both the TUI and the browser now streams live (tokens, tool calls, status) to both surfaces, and `abort`/`steer` from either stops or redirects the turn for both. `cast web stop` now also disconnects the TUI's SSE stream. Set `CAST_NO_DAEMON=1` to keep the TUI on the previous local-loop path (CI/headless).

## 0.12.28

### Fixed

- Web sidebar: search showed "No sessions match <query>" on every non-empty search, hiding the matches above it. The empty-state check compared the wrong list (the full session list, which is empty when a search is active) instead of the filtered list. Now the banner only appears when the filter actually returns nothing.
- Web Changes tab / Files tree: external file edits in the session cwd (IDE save, CI hook, `touch`, etc) now refresh the diff and the file tree in real-time. Previously the only source of refresh was the next agent tool_end. A non-recursive `chokidar` watcher on the cwd root fires an `fs_change` SSE event after a 500ms debounce while the session is idle, gated so it never races a running turn. Top-level and subdir paths both work; `.git`, `node_modules`, `dist`, `build`, and other noise directories are ignored. The native `fs.watch` path had an inotify `max_user_watches` ceiling that silently killed the watcher on real-world cwds — chokidar's pooling avoids it.
- Web sidebar footer: showed "No model selected" for a frame between mount and the `/api/config` response arriving. The sidebar now renders "Loading…" until the model has actually been fetched.

## 0.12.27

### Added

- TUI: `/reasoning-display` command to hide reasoning blocks by default. The setting is persisted to `settings.json` and survives restarts.
- Web: reasoning-display toggle in Settings > Appearance, synced with `settings.json`.

### Fixed

- Web streaming reasoning block: the 1200-character cap from v0.12.21–v0.12.25 is restored. An earlier v0.12.26 commit had removed it, which let long reasoning streams disable the TUI scroll guard and produce occasional "jumps" in the visible content. The cap keeps the cursor-below-viewport invariant that `useTerminalResync` depends on.

### Internal

- Several experimental TUI reasoning-display tweaks that landed on `master` after v0.12.26 (1-row live preview redesign, `\n` flattening in live/settled history, hidden-think-block clamp accounting) have been reverted. They never shipped in a release.

## 0.12.26

### Fixed

- Sidebar / picker row listing was slow on big DBs — `listSessionSummaries` and `searchSessionSummaries` previously built each session's summary by SELECTing every user/assistant `content_json` row, JSON.parsing the whole conversation, and counting turns in JS. On a 218-session DB that meant 9 MB of allocations and 9000+ JSON.parse calls per listing. The new path aggregates in SQL via covering indexes: user count and assistant count via `idx_messages_role`, the with-tool-calls slice via PRIMARY KEY + JSON filter then subtracted to preserve the old "exclude intermediate tool-call-only steps" semantic, and the first user message via a `MIN(seq)` JOIN on the primary key. Field-level semantics of the row's `msgCount` and `firstUserMessage` are unchanged. Measured on 57.131.129.41 with 218 sessions: TTFB on `GET /api/sessions` dropped from 448 ms to 138-163 ms (3x faster).

## 0.12.25

### Fixed

- 400 context window exceeded now auto-recovers from the agent loop instead of killing the turn. When the LLM rejects a turn with a context-overflow, the loop now drops the largest tool result in history (any `read`/`grep`/`web_fetch` whose output is already anchored in the conversation and was being re-sent on every retry), replaces it with a short placeholder that names the `tool_call_id`, the size that was dropped, and how to re-fetch with a narrower scope, and appends a `<system-reminder>` so the model re-issues the call with `offset/limit` instead of asking for the same content again. The new path runs once per turn; if the in-place shrink wasn't enough the existing LLM-based compaction path tries next, so the user only sees a raw error after both options have failed. `tool_call_id` is preserved across the swap so the conversation stays wire-valid for the next retry.

## 0.12.24

### Fixed

- TUI streaming flicker on every token: `ThinkBlockParser.parseContent` / `flush` returned the entire accumulated buffer on each chunk, but the `StreamChunk` contract is delta-only — downstream does `content += chunk.content`. The cumulative return made each per-token redraw re-render every prior line, so the assistant visibly typed "line by line" with each previous line reprinted before the next arrived. The parser now tracks an `emittedBufferLen` offset and returns only what's new since the last yield, slicing the underlying buffer with `[emittedBufferLen, …]`. The buffer is compacted only when the already-emitted prefix grows to a meaningful fraction of the total length (keeps amortised cost flat on long streams without shifting the offset). Covers both the think-block and content branches and the trailing-tail `flush`. Web UI streams ride the same parser, so the web client picks up the fix for free. Regression test added in `test/vendors.test.ts`.

### Added

- Web UI file preview: copy-to-clipboard button next to the existing download icon. For text/table previews it copies the rendered content once it has loaded (disabled until then); for image/PDF it copies the preview URL. Brief check-mark confirmation via the existing `icons.check` for ~1.5s. Falls back to a hidden `textarea` + `document.execCommand("copy")` if the modern Clipboard API isn't available, and swallows denied-permission errors silently so the modal stays usable.

## 0.12.23

### Added

- Web UI: `cast web status` is now reachable from inside the running browser session — new "Server" tab in Settings shows whether the daemon is running, its pid, host:port (with a "reachable from other machines" note when bound to `0.0.0.0`), start time and uptime. Same info as the CLI command; the panel calls the new `GET /api/web/status` endpoint, which reads the daemon state file via `readLiveWebState` so a stale entry (process gone) is auto-cleaned on read.

### Fixed

- TUI: a long reasoning stream (`SPLIT_REASONING_CHARS = 1200`) could render as N `[reasoning]` sections instead of one. `appendTextBlock` forced `continued: false` on the split-off chunk and on the previous block when a different kind took over, so the `[reasoning]` prefix in ChatLog rendered again on every mid-run chunk and on the tail at the kind boundary. The split-off chunk now inherits the source block's `continued` flag (`block.continued ?? false`) and the kind-boundary settle now preserves `last.continued ?? false` instead of forcing `false` — so only the very first chunk of the run carries the prefix, every later chunk is a silent continuation. Data is unchanged (still no loss across splits); the active tail stays bounded by the scroll-guard cap. `stream-blocks.js` is browser-neutral, so the same fix tightens the web UI's collapsed reasoning output for free.

## 0.12.22

### Fixed

- Web UI: clicking a thread closed the sidebar immediately and highlighted only the newly-selected row, instead of waiting for the `/api/sessions/:id` fetch to land and glowing both old and new at once. `setSidebarOpen(false)` now runs at the start of `selectSession` (right after `setSelectingId`) so the drawer collapses instantly on big-thread clicks that take a second or two to load. The chat area's "Loading…" empty-state already takes over during the same window, so the user sees a clear "switching" state instead of a stale list with a mute click. The dual-highlight bug — `isActive = s.id === activeId || selecting` matched both the previous active row AND the new selecting one during the transition — fixed by switching to `isActive = selecting || (s.id === activeId && !selectingId)` (added `selectingId` as a prop so the formula can tell "this row is the picker target" from "some other row is the picker target"). Bootstrap / popstate paths don't go through `selectSession`, so their old "wait for response" timing is preserved.

## 0.12.21

### Fixed

- TUI: long reasoning streams could trigger a rare scroll jump when the user scrolled up mid-stream. A single still-streaming `thinking` block grew unbounded and pushed the live region past the viewport, which disabled `useTerminalResync`'s DECXCPR cursor poll (the natural cursor-below-viewport position looks identical to a user scroll). With the poll off, Ink's `CUU + erase` redraws landed at the wrong rows on user-initiated scroll and the visible content jumped. `appendTextBlock` now caps the active reasoning block at 1200 chars (`SPLIT_REASONING_CHARS`) — the older portion moves into a settled (continued: false) sibling that drains to `<Static>`, the active block keeps the tail. The live region stays within the viewport, the poll keeps running, and the scroll guard works as intended. Content and tool blocks are unaffected (content already drains via `splitCompleteLines`, tools stay compact).

## 0.12.20

### Fixed

- First-run reasoning picker for MiniMax: `buildReasoningParams` for format `"minimax"` funneled every non-`adaptive`, non-`disabled` value (including `"off"` and stale levels like `"low"`/`"medium"`/`"high"`/`"max"` that can land here from a saved `reasoningLevel` set against a different provider) into `{ reasoning_split: true }` with `enabled: true`. For `"off"` that meant picking "off" was a no-op — the server's always-on default still ran reasoning. Reorder the switch so `off` / `disabled` map to `thinking: { type: "disabled" }` with `enabled: false` (verified live against api.minimax.io), `adaptive` stays its own branch, and the always-on fallback serves only true "on" levels. Hotfix on the reasoning dialect ladder that landed in 0.9.10.

## 0.12.19

### Added

- `/undo` command: rolls back the last turn — restores files from the turn's checkpoint (shadow copies of files the agent touched) and drops the last user message and everything after it. Refused while the agent is running (use `/abort` first). No-op when there's no checkpoint (very first turn, or `/clear` already rolled the session back). Web UI shows a `[Undone: ...]` notice when triggered from the client.
- `/undo` requires `src/core/checkpoint.ts` — shadow file storage + a marker on the parent commit for any new files added during the turn, restored on demand.

### Fixed

- Web UI marketplace install: button no longer reappears after a successful install. The panel was reading `data.plugins` from its own props (always undefined — parent passed only `data.marketplace`), so the installed-plugin check silently failed and the row kept showing "Install" after install. Now the parent passes the installed list as a separate prop and refreshes it after every `/plugin` command.
- Web UI marketplace install feedback: per-row pending state with a spinner mid-flight plus a brief `installed ✓` label on success. The modal's global `busy` flag only flashed for ~100ms, which read as a no-op click.
- Web UI marketplace block: stray horizontal scrollbar suppressed. `.plugin-catalog-list` had `overflow-y: auto`, which implicitly makes the x-axis `auto` too; long descriptions triggered a horizontal scroll where only vertical should exist. Explicit `overflow-x: hidden` keeps vertical scroll, kills horizontal.

### Internal

- Biome warnings on new `/undo` and worktree code: removed unused imports (`copyFileSync`, `realpathSync`, `sep`, `samePath` in `checkpoint.ts`; `createCheckpoint` in `commands.ts`; `AppConfig` type in `bridge.ts`); hoisted a hot-path regex literal in `commands.ts` to a module-level constant.

## 0.12.18

### Fixed

- Web UI settings modal layout on mobile: form fields stack vertically instead of cramming 3 inputs into one narrow row; select dropdowns (Web tab search/fetch) are full-width instead of clipped at 180px; marketplace plugin names truncate with ellipsis instead of overflowing the card with horizontal scroll.
- Web UI settings dom warnings: password inputs wrapped in `<form>` elements; API key field given `autocomplete="off"`.
- Web UI model pickers streamlined: removed "(reasoning)" suffix from model names, removed "— @ provider" tags from section titles, sub-agent and plan-mode provider pickers now show "openrouter (default)" instead of duplicating the active provider in the dropdown list.
- Web UI composer: placeholder simplified to "Type a message…", max-height raised to 150px to prevent scrollbar on mobile.

### Changed

- Web UI settings reasoning section: "Reasoning — current: off" simplified to just "Reasoning".

## 0.12.17

### Fixed

- Web UI composer placeholder simplified to just "Type a message…" — the previous context-sensitive hints ("↑↓ to navigate, Enter to pick" / "Type your answer…") were truncated on narrow mobile screens and added no value since the picker UI is self-explanatory.
- Web UI composer textarea no longer shows a scrollbar on mobile when the text wraps past two lines. `max-height` raised from 100px to 150px, and `overflow: hidden` removed (it was blocking the JS auto-resize on iOS).

### Internal

- 69 inline regex literals hoisted to module-level `const` declarations across `src/` (biome `performance/useTopLevelRegex`), including all core modules (`frontmatter`, `hooks`, `mcp`, `plan`, `plugins`, `rules`, `session`, `skills`, `tools/`, `llm`, `vendors`, `startup`, `upgrade`), all UI modules (`commands`, `keys`, `stdin-buffer`, `input-parser`, `word-nav`, `useTerminalResync`, `App`), and all web modules (`app`, `composer`, `message-submit`, `reasoning-split`, `sidebar-utils`, `tool-card`, `new-session-modal`, `server`, `bridge`, `commands`).
- 16 `noAwaitInLoops` warnings suppressed with explicit engineering justification — all are genuinely sequential operations where `Promise.all` is semantically wrong or unsafe: the main agent turn loop, SSE streaming, MCP cursor pagination, provider probe retry, filesystem traversal (EMFILE risk), sequential file upload, and interactive SSH key/picker prompts.
- Removed one unused `GITHUB_URL_PREFIX` const in `bridge.ts`.
- `text-replace.ts` regex consts repaired after a broken `replaceAll` in an intermediate commit self-referenced one const and left three others unused. Tests back to 1508/1508.

## 0.12.16

### Added

- `/worktree <name>` slash command — switch the running session into an isolated git worktree from inside the TUI. Behaves identically to the existing `--worktree <name>` CLI flag: creates the worktree at `<repo>/.cast/worktrees/<name>` on a fresh `cast-<name>` branch off `HEAD` (or reuses an existing one), switches `session.cwd` so subsequent bash/read/write/edit see the worktree path, and leaves the main checkout untouched. A new `state` event's `cwd` field reflects the change so headless consumers can observe it. Branches off `findCanonicalGitRoot`, so `/worktree nested` invoked from inside a worktree still anchors the new one at the main repo's `.cast/worktrees/` dir — no linked-worktree-of-a-worktree.
- `cast run --interactive` (JSONL protocol) now accepts a `command` action that pipes a slash command through the same `handleInput` the TUI uses, so evaluators and headless agents can drive `/worktree` (and any other slash command) end-to-end without a real TTY. `{type:"command",name:"worktree",args:" foo"}` is the canonical shape. `notice` events forward transient toasts; `state` events carry `cwd = session.cwd ?? result.cwd` so cwd changes are observable.
- `--worktree <name>` / `-w <name>` (also on `cast run`) runs the session inside an isolated git worktree. The worktree is created (or reused) at `<repo>/.cast/worktrees/<name>` on a fresh `cast-<name>` branch off `HEAD`; bash, read, write, and edit all see the worktree path, and the main checkout is left untouched. Two `--worktree` runs in parallel never collide. Add `.cast/` to your `.gitignore`. The worktree and branch are left on disk on exit — remove them with `git worktree remove .cast/worktrees/<name>` and `git branch -D cast-<name>` when done. Requires being inside a git checkout with at least one commit; both `--worktree foo` and `--worktree=foo` are accepted.

### Changed

- `cast -c` / `cast --continue` is now scoped to the current working directory. Previously it resumed the most recent session *globally* (whatever project was last touched on the machine), which silently dragged the agent into an unrelated project when the user `cd`'d somewhere fresh. It now resumes the most recent session in the *current cwd* and exits 1 with a clear error if no session exists there. The "no session" check runs *before* provider-model fetch and MCP setup, so the failure path is fast (milliseconds) instead of waiting on a 15-second model probe first. `--resume=<id>` still works globally — the lookup by explicit id is not cwd-bound, since the user already knows which session they want. Mirrors `claude -c`'s behaviour (an upstream tracker for the same bug is anthropics/claude-code#35226).
- Web UI: `preact`, `preact/hooks`, and `htm` are now served from `/vendor/*.mjs` instead of `https://esm.sh/...`. On a remote network with non-trivial RTT to esm.sh this removes 3 round-trips from the critical render path (~900ms saved on a 100ms-RTT connection, where each preact fetch takes ~400ms); on localhost the improvement is invisible because the round-trips are sub-10ms. CSP also drops `https://esm.sh` from `script-src` and `connect-src` since no code path needs it anymore. The google-fonts preconnect hints are downgraded to `dns-prefetch` since the only font load is user-initiated (Settings > Font) and the DNS resolution cost on every page load was wasted for the 99% of loads that never switch.
- Web UI composer submit no longer refetches the whole session list after sending a message. The previous `loadSessions()` round trip was redundant — the server pushes `session_update` SSE events with the new message count and auto-derived title after every turn — and it stalled the optimistic feedback loop so the user saw nothing change in the sidebar until the round trip landed.

## 0.12.15

### Added

- Web Settings → Model tab now exposes a 3-state `thinking` control for MiniMax-M3 (Enabled / Adaptive / Disabled) instead of a single always-on toggle. The wire format matches the live OpenAI-compatible API: Enabled is the default (no field), Adaptive sends `thinking: { type: "adaptive" }`, Disabled sends `thinking: { type: "disabled" }`. The Web UI now surfaces the saved level in the section header (previously hard-coded to "off" because the web `/current` endpoint was not returning the field).

### Fixed

- Web Settings → Provider tab no longer freezes the modal: `SettingsProvider` was calling `useRef` without importing it, so the click on the tab threw `ReferenceError` during render and Preact dropped the pane subtree. The picker now renders the saved providers, edit/delete buttons, and the add form.
- Web Settings → Model tab reasoning picker mirrors the saved level after apply. The dropdown previously snapped back to "Pick a level…" after a successful apply, which made the selection look lost; it now stays on the just-applied value and the ✓ button returns to its gray state when the picked value matches the current one.

## 0.12.14

### Fixed

- Web UI theme picker now wraps long theme names inside the swatch button so the full label is visible instead of overflowing the card.
- Open-work gate no longer leaks the user-facing "falling through to the user" notice into the model transcript: it is delivered only through the `open_work_gate_exhausted` event, so a resumed session does not re-read the orphan reminder.

## 0.12.13

### Fixed

- TUI question picker now forwards the user's free-form answer to the model instead of a literal `(custom — see above)` placeholder, and the web bridge accepts any value (not just model-supplied options), so a custom answer typed in the composer no longer gets dropped.
- Web question card now shows an inline textarea under each option group so the user can type a custom answer alongside the model-supplied options; the textarea is styled to match the option buttons.

## 0.12.12

### Fixed

- Preserved Web UI tool card state (expanded result, open image preview) across the rest of the turn: a tool the user opened no longer collapses when another tool's `tool_start` / `tool_end` event arrives, and stays open through the final `assistant_message` swap from the live stream into the settled message.
- Added `Content-Encoding: gzip` for `/api/sessions/:id` and other JSON responses above 8KB; large agentic threads open noticeably faster on slow links (the `/api/sessions/:id` payload typically drops 5-10x with the repetitive tool output these threads contain).
- Added a `(session_id, role, seq)` index on the `messages` table to back `getHistoryPage`'s boundary lookup and existence check.

## 0.12.11

### Fixed

- Preserved in-progress Web UI reasoning and tool blocks across page reloads, including deterministic ordering while a tool is running.
- Reconciled active streaming snapshots with persisted assistant messages to prevent duplicated or reordered reasoning and tool cards after reconnects.

## 0.12.10

### Fixed

- Fixed TUI and Web UI question pickers so multi-question flows do not reopen duplicate pickers or remain visible after answering.
- Fixed plan approval options to render vertically and removed duplicate plan decision notices.
- Fixed TUI plan mode so `plan_done` remains available after switching from Build mode, including providers that require explicit tool parameters.
- Added provider request timeouts and a bounded LLM retry deadline so Settings and stalled provider calls no longer remain in loading indefinitely.
- Updated question answer summaries to use the compact `Question: … Answer: …` format.

### Changed

- Split token scoreboard metrics into input/output percentile columns and removed obsolete Commit and Consistent columns.

## 0.12.9

### Fixed

- Fixed Web UI startup after the recent client modularization by restoring the resource-load and modal-focus hooks used by the root application.

### Changed

- Split Web UI settings panels, message submission, panel resizing, and SSE handling into focused modules without changing the TUI or Web UI behavior.

## 0.12.8

### Added

- Added a themed web sign-in page with HttpOnly, SameSite session cookies, SQLite-backed web sessions, disabled API caching, and failed-login rate limiting.
- Added provider-aware reasoning configuration documentation and built-in references for providers, web access, and project configuration.

### Fixed

- Project-local hooks now participate in the project trust prompt even when `.cast/hooks.json` is the only local resource.
- Existing sessions now derive missing sidebar titles from their first user message, while explicit blank titles remain unchanged.
- Updated plan, MCP, hooks, skills.sh, tool, and eval documentation to match the current runtime and CLI behavior.

### Changed

- Simplified the shared Cast prompt so configuration guidance has one source of truth in the built-in `cast` skill.
- Removed the obsolete prompt-secrecy rule from the open-project harness discipline.

## 0.12.7

### Added

- Added a behavior evaluation bench covering planning, tool use, task execution, and other core interaction contracts, with a certification "Model Scoreboard" published on the docs site (`--scoreboard` on the eval runner records each model's per-case pass rate across at least 3 attempts per case).

### Fixed

- Completed web planning transitions so plan decisions consistently reach the intended next state.
- `grep`: aligned glob paths across the ripgrep-backed and built-in fallback implementations, and fixed the fallback failing to match when the search path names a single file instead of a directory.
- Rendered escaped Unicode in tool results as readable text.
- Stabilized web settings and session interactions.
- Plan mode's read-only command check rejected safe commands like `ls -la 2>&1` or `cmd >/dev/null 2>&1` — fd-duplication and null-device redirects were caught by the blanket output-redirection guard even though neither writes a persistent file.
- `bash`: background tasks (`run_in_background: true`) no longer get killed by a default timeout — they're open-ended by default (dev servers, long builds) and only get a kill timer when the model explicitly passes `timeout`. A `timeout` of `0` or negative is treated as "no timeout" rather than firing almost immediately.
- `/continue` and starting a new session now restore the full session state (reasoning settings, turn metadata, title, pinned flag, todos, share token) instead of a partial subset, and reset SSH host resolution and provider/model validation consistently when switching sessions or projects.

### Internal

- Added plan, task, and skill judgment cases plus single-tool core contract coverage; eval cases now support an isolated per-case working directory so a case's synthetic scenario can't be second-guessed against the real repo.
- Fixed a fixture race condition in the eval runner's `--repeat` mode where concurrent attempts of the same case corrupted each other's on-disk fixture state, and wired `--baseline` regression comparison into `--repeat` runs (previously single-run only).
- Synchronized evaluation and tool documentation with the current behavior bench and background Bash behavior.

## 0.12.5

### Fixed

- Planning flow: complex build-mode tasks now consistently request planning before implementation, while an explicit user choice to continue in Build is preserved across subsequent turns.
- Web UI: plan-mode entry and plan approval now use the same choices as the terminal UI, including refine, immediate implementation, fresh-context implementation, and manual Build handoff.
- Web UI: every plan-mode decision is saved as a persistent system card in the chat history, so the selected path remains clear after reload.

## 0.12.4

### Fixed

- Web UI: settings remain responsive when adding or removing Skills.sh skills, including when Settings is opened from a fresh root draft with no visible session.
- Tool output: valid JSON containing Unicode escape sequences now renders as readable text in both the web UI and terminal UI.
- Web UI: font previews are local and stable, so the picker shows each typeface immediately without late-loading flicker.
- `grep`: directory-component globs now match relative to the requested search path consistently whether ripgrep is installed or the built-in fallback is used.

## 0.12.2

### Fixed

- Web UI: hover tooltips were silently broken on message rows after the mid-word boundary-merge rework — the `PAD` constant the tooltip layout depended on had been removed alongside the dead hover-cancel code path. Restored; tooltips on user / agent / reasoning rows, tool cards, and MCP tool rows are back.
- Web UI: when a streaming reply was truncated by `max_tokens` *inside* a model-emitted draft answer (i.e. reasoning had already closed and the model was emitting real content for the user when it ran out of budget), the partial answer was being discarded. The last accumulated content is now flushed into its own `[agent]` block — same way the answer-after-reasoning case was handled in 0.12.1.
- Web UI: mid-stream mouse movement no longer cancels a hover tooltip before it appears. The previous `mousemove` → cancel handler kept the tooltip code technically alive but fired on every cursor wiggle and never let the 500ms hover-intent timer complete. Removed; tooltips open on the intended timer and only the standard `mouseleave` / scroll / modal-open paths dismiss them.
- Web UI: the browser's native tooltip is stripped the moment the cursor enters the trigger element. Otherwise both tooltips render and the native one wins the race on leaving the page, briefly showing the plain `title` text over the styled bubble.
- Web UI: custom hover tooltips are suppressed on coarse-pointer / touch devices, where they have no interaction model and were firing on tap-and-release.

### Changed

- Built-in `cast` configuration skill: split the 397-line `SKILL.md` into a short index + seven `references/*.md` topic files (personas, skills, marketplace, mcp, rules, hooks, commands). The skill now follows the agentskills.io progressive-disclosure convention — only the frontmatter + topic map (~1.6 KB) is loaded every time `cast` is invoked for a config question, and the matching reference file is read on demand. For a focused question (e.g. "how do I add an MCP server?") the model pulls just `references/mcp.md` instead of every topic.

## 0.12.1

### Fixed

- Web UI: when a reasoning block ended with a markdown heading (a truncated answer draft that the parser flushed into reasoning because the model ran out of `max_tokens` inside `<think>` without emitting a close tag), the post-heading tail is now rendered as a separate `[agent]` block instead of sitting inside `[reasoning]` next to a blank agent area. Applies to live streaming, settled turns, and reload from disk.
- Web UI: when the model's `<think>...</think>` boundary landed *mid-word* (observed on MiniMax-M3 emitting `</think>` inside the Cyrillic word "Сейчас", so reasoning ended "...Сей" and content started "час уточню..."), the trailing word fragment is now glued back onto the agent's content. The user sees the model-intended continuous word — "Сейчас уточню текущую погоду в Астане." — instead of two halves separated across blocks. Same-script check (Latin↔Latin, Cyrillic↔Cyrillic) guards against false merges across alphabets; sentence-ending punctuation inside the fragment stays in reasoning.

## 0.12.0

### Added

- **Per-persona allowlists** for tools, skills, MCP servers, and subagent types. Each persona's frontmatter now supports four knobs that all share the same shape (omitted = no restriction, `[]` = explicitly nothing allowed, exact names or `*`-globs):
  - `tools:` — built-in tool names (existing). `tools: [read, grep, ls, plan_*, web_*]` narrows the persona's builtin reach.
  - `skills:` — skill names invokable via the `skill` tool. `skills: [research, deep-research]` hides every other skill from the catalog and the runtime.
  - `mcp:` — MCP **server** names (not individual tool names). `mcp: [postgres, playwright*]` keeps only those servers' tools callable.
  - `subagentTypes:` — narrows `subagents: true` further. `subagentTypes: [explore, review]` is the only set this persona can spawn via `task`.

  Enforced at runtime (not just in the prompt text) — a disallowed call gets the same "not available" / "not found" / "Unknown subagent" message the model already gets for any hidden tool, so these actually isolate a persona's zone of responsibility. `skills:` / `mcp:` restrictions also forward to anything the persona delegates to via `task`, so the restriction can't be routed around by spawning a subagent.

  Default persona is now `senior` (the previous `coding` persona was a strict subset and is removed). `coder-with-subagents-force-review` is also removed — its review gate now lives in `coder-with-subagents`'s own validation pattern.

## 0.11.1

### Fixed

- `cast web <typo of stop|status>` no longer silently starts a new server daemon — any unrecognized subcommand now errors instead of falling through to the default "start" behavior.
- `cast upgrade --<typo of --force>` no longer silently attempts to upgrade to a "version" named after the mistyped flag — unknown flags now error before that logic runs.
- `/ssh <typo of add|remove>` (terminal UI) no longer silently falls back to listing hosts — unrecognized subcommands now error.

## 0.11.0

### Fixed

- Skills.sh: installing via the web UI now actually lands where cast scans (`~/.agents/skills/`) — installs used to silently vanish depending on which agent flag was used.
- Skills.sh: pasting skills.sh's own "npx skills add ..." command into the install field now works, not just the bare `owner/repo --skill name` args.
- Skills.sh: the installed-skill list now shows the real source repo (read from the skills.sh lockfile) instead of a mis-parsed label that was always empty.
- Skills.sh / SSH: command output no longer leaks raw ANSI escape codes (cursor show/hide sequences) into the UI.
- Settings modal: a failed action no longer leaves every button in the modal permanently disabled.
- Diff/Files panel: a manually resized width now survives a page reload.
- Hooks: a hook that force-stops the turn no longer silently drops `updatedInput`/`additionalContext` contributed by other hooks in the same run.
- Hooks: a `PostToolUse`/`PostToolUseFailure` hook that blocks with no output of its own no longer has its block silently dropped.
- Hooks: two identical hook groups from different sources (e.g. a plugin and a project file) no longer share an id, so disabling one no longer disables the other.
- Hooks: a malformed `hooks.json` now surfaces a parse-error diagnostic in Settings and `/hooks` instead of silently loading as empty.

### Changed

- Web UI: Marketplace tab browsing merged into one flat, searchable list across all configured marketplaces instead of per-marketplace tabs.
- Web UI: Skills.sh tab dropped the "list available" (browse-a-repo) field and the network-backed search box.

## 0.10.1

### Fixed

- Hooks: `${CLAUDE_PLUGIN_ROOT}` substitution in command strings so plugins shipped with Claude Code's marketplace (e.g. hookify, ralph-loop) load and execute unmodified.
- Hooks: case-insensitive tool-name matching in `if` conditions so `if: "Bash(git commit:*)"` matches payloads where the tool name is lowercase "bash".
- Skills: `skill` tool description in `/skill-instructions` now explicitly tells the model to call the `skill` tool (not `read`) and to load skills FIRST when the request matches a description.
- Personas: every persona's Tools section mentions the `skill` tool with a generic description (no skill-name examples, to avoid locking in a specific subset).

### Changed

- Skills prompt listing now includes `whenToUse` alongside `description` (formatted as `description — whenToUse`) for richer model matching.

## 0.10.0

### Added

- Hooks: full implementation matching the Claude Code protocol — shell/HTTP commands fire on lifecycle events to validate/block a tool call, log activity, or keep the agent working before it stops. Configure via `.cast/hooks.json` (project) or `~/.cast/hooks.json` (global); manage with `/hooks`, `/hooks enable|disable <id>`, `/hooks help`.
- Web UI: Settings → Hooks tab, mirroring `/hooks` (per-source grouping, enable/disable toggle).
- Skills: dedicated `skill` tool replaces the model reading `SKILL.md` via the generic `read` tool — validates the name, enforces `disable-model-invocation`, and performs argument substitution in one call.
- Skills: `$ARGUMENTS`, `$ARGUMENTS[0]`/`$0`, and `${CLAUDE_SKILL_DIR}` substitution in skill bodies, plus a `when_to_use` frontmatter field surfaced in the skill listing as `description — whenToUse`.
- Web UI: marketplace tabs with a plugin catalog browser (alphabetically sorted tabs and plugins, full descriptions).

### Changed

- Web UI: Settings panel restyled — MCP/Skills/SSH intro text switched from a collapsible `<details>` to an always-visible summary line; item rows, plugin catalog entries, and theme/font swatches share a consistent card/hover treatment; Plugins tab renamed to Marketplace, settings tabs sorted alphabetically (opens first tab by default).
- Web UI: font swatches load their Google Fonts stylesheet so every option previews in its own font instead of falling back to the system font.

### Fixed

- Case-insensitive tool name matching in hook `if` conditions.
- `${CLAUDE_PLUGIN_ROOT}` substitution in hook command strings for plugin compatibility.
- Hook protocol parity — missing payload fields and output formats now match Claude Code's.
- MCP/Skills/SSH settings tabs now work while the agent is running.

## 0.9.14

### Fixed

- Vision error fallback now catches 400 status codes in addition to 404, so provider image-rejection errors (e.g. oversized base64) trigger image stripping and retry instead of surfacing a raw 400 to the user.
- Per-file image read cap lowered from 25MB to 5MB to match provider limits, preventing images from being embedded only to get rejected at the API.

## 0.9.13

### Internal

- Zero biome lint warnings/errors project-wide.

## 0.9.12

### Changed

- `todo_write` is now guidance-based — the hard gate that blocked non-todo tool calls after 4 work actions is removed. The model decides when to use `todo_write` based on task complexity, same as opencode's `todowrite`.

## 0.9.11

### Fixed

- Web UI: the Inputs tab loading state now uses the same "Loading…" style as every other panel instead of an inconsistent title-sized label.

## 0.9.10

### Fixed

- Web UI: the Inputs sidebar no longer shows a stale "No files attached" flash when re-fetching after a document upload or during agent-response re-renders.
- Web UI: attached documents in a draft session (before the first message was sent) now work — the upload is deferred to `submitMessage` after `commitSession` creates the real session, instead of blocking with "send a message first".
- Web UI: a double `commitSession` call when drafting a session with pending documents created two separate sessions — files landed in the first, the message in the second, so the Inputs tab was empty while the chat showed the files. A single `id` variable now flows through both blocks.
- Web UI: the sidebar's "No sessions match" empty state no longer flashes during initial load before the session list arrives.

### Changed

- Web UI: tightened chat vertical spacing — smaller gap, leaner padding, and reduced line-height for denser messages.

## 0.9.9

### Added

- Session search (TUI and web) now runs on a SQLite FTS5 index over full message history instead of a JS fuzzy scorer — same relevance ranking in both interfaces, and a multi-word query now matches across different messages in the same conversation instead of only within one.
- `web_fetch` gets a second backend: "local" fetches the URL directly (no third party sees it) and converts HTML itself, with a Cloudflare-challenge retry, a 5MB response cap, and content-type checks that reject binaries. Switch with `/web-fetch-provider jina|local` (default stays `jina`).
- Web UI: an "Inputs" tab (right sidebar, ordered Inputs/Files/Changes) for a session's attached documents.
- Web UI: the composer's attach button now accepts documents, not just images — non-image files upload to a session-scoped directory and the model gets told their path via an invisible reminder on send. Executable/binary formats are rejected; archives and ordinary documents are allowed.
- `cast web`'s MCP servers now connect in the background after the HTTP server starts listening, instead of blocking startup on every configured server (npx spawns, browser launches, remote handshakes) — the server accepts requests immediately, and connected tools become available in any open session automatically once the connect finishes.

### Changed

- Web UI: the "Tools" settings tab split into three — Bash, Web, Quick Mode — each loading only the data it needs instead of five settings commands on every open.
- `web_fetch`: one retry on a transient network failure or 5xx (never on an intentional abort or a 4xx), and truncation now prefers the nearest paragraph break over a mid-sentence cut.

### Fixed

- `web_fetch` now rejects non-http(s) URL schemes (`file://`, `data:`, ...) before ever making a network call.
- `cast web status`/"already running" could report a server as up before it was actually accepting connections — the daemon state file is now written only once the HTTP server is truly listening, matching its own documented contract.

## 0.9.8

### Fixed

- Web UI: tooltips display as a single horizontal line instead of wrapping into a narrow column due to `max-width` and `word-break` constraints.
- Web UI: `assistant_message` handler now uses event payload (`content`/`thinking`/`toolCalls`) as fallback when streaming blocks are empty, preventing silently dropped messages on SSE interruptions.

## 0.9.7

### Added

- Web UI: custom tooltip system — themed bubbles with fast appearance, viewport-aware positioning, no truncation.
- Web UI: keyboard shortcuts icon (heroicons-compatible outline style).
- Web UI: all settings tabs now have collapsible help sections (Model, Tools, MCP, Skills, SSH, Plugins).
- Web UI: SSH settings now support password authentication (requires `sshpass`).

### Changed

- Web UI: Settings modal widened from 620px to 820px for better readability.
- Web UI: help sections in Tools and Model tabs now use inline hints after each section title instead of a single collapsible block.
- Web UI: theme swatches redesigned with grid layout — dot left-aligned, label centered.
- Web UI: every theme now carries its own background palette (bg, bgSurface, bgRaised, bgHover, border, borderActive) with improved contrast between UI layers.
- Web UI: 6 themes (Nord, Solarized, Catppuccin, GitHub, Dracula, Gruvbox) use official background colors from their design specifications.
- Web UI: reasoning blocks and turn-meta footer now use `--text-dim` for better readability.
- Web UI: chevron icon in collapsible sections replaced from CSS triangle to genuine Heroicon.

### Fixed

- Web UI: loading spinners now centered in settings pane, diff panel, and file previews.
- Web UI: Tavily and Brave Search input fields aligned to equal widths.
- Web UI: SSH hosts form reordered — password field before key field.

## 0.9.6

### Internal

- Removed unused `formatActiveRulesPrompt` — the per-turn rules path has used `formatRulesForTurn` (single combined `<rules>` block) since it was introduced; the legacy two-part formatter had no callers outside its own tests.

## 0.9.5

### Added

- Two new built-in personas: `researcher` (web-search-driven investigation, cites sources) and `assistant` (general-purpose everyday help — advice, quick lookups, drafts — that reaches for tools only when a task actually needs them).
- Web UI: the Files panel's `.md` preview now renders through a real markdown engine (headings, lists, tables, links) and code files get real per-language syntax highlighting, both vendored for fully offline use. The Settings → Skills "read full content" view got the same treatment, in the same size modal as the file preview.
- Web UI: every finished agent reply now shows its own "provider · model · Ns" footer, persisted per-turn — a thread with several exchanges shows a footer under each one, not just whichever was most recent, and it survives a full page reload.

### Fixed

- Web UI: a disabled plugin's skill still worked as a native slash command and stayed listed in the composer palette — both now correctly disappear.
- TUI: `/plugin` silently cloned three GitHub-hosted default marketplaces on first use with no way to tell where they came from. They're back as permanent, always-present catalogs (labeled "built-in" in the web UI), but non-removable and no longer a surprise — `/plugin marketplace add` is the documented way to add your own.
- Web UI: Chinese trigger phrases removed from three built-in skill descriptions; the command palette now truncates a long description with an ellipsis instead of letting it overflow the row.
- Web UI: clicking a file's icon or the empty space in its row (not just the filename text) now opens its preview, matching the whole row's hover/click-target styling.
- Web UI: fixed the Files preview's markdown spacing (was inheriting the chat's pre-wrap styling, doubling up as huge line gaps), added Escape-to-close, and removed a raw-then-rendered flash on a slow connection.
- Web UI: the stale "provider · model · Ns" footer and elapsed-time counter from a just-finished session no longer bleed into a brand-new session.
- Web UI: centered "Loading…" states that were pinned top-left instead of filling their container (Settings tabs, Status popover, Files panel's initial load).
- Web UI: a hand-approximated `chevronUp` icon path was fixed to match its actual Heroicons source.

## 0.9.4

### Added

- A loaded skill can now be invoked as a native `/<skill-id>` slash command in both the terminal and web composer — it shows up in autocomplete with its own description, no `/skill:name` prefix needed. `/reload` (and enabling/disabling a skill in the web Settings modal) refreshes the list immediately.

### Fixed

- Web UI: Settings could only be opened once a session existed — the gear icon did nothing on a brand-new draft thread. It now always opens; tabs that need a session (Model, MCP, Provider, etc.) show a hint instead of hanging on "Loading…" until one exists.
- Web UI: removed the redundant close button on the Changes/Files panel — the topbar toggle already closes it.
- Web UI, mobile: opening the sidebar while the Changes/Files panel was open (or vice versa) used to leave the one you just opened hidden behind the other, forcing a manual close-then-open. Opening either drawer now closes the other automatically.

## 0.9.3

### Added

- Web UI: the Files panel now shows a live preview when you click a file — text/code renders as-is, images render inline, PDFs open in the browser's own viewer, and CSV/TSV render as a real table (auto-detecting the delimiter — semicolon, tab, or pipe, not just comma).
- Web UI: files and folders in the Files panel can be renamed in place, the same inline-edit as renaming a session in the sidebar.
- Web UI: the Files panel now refreshes on its own — a write/edit that lands while it's open shows up without collapsing and reopening the folder, and the diff/Files panel's open state and active tab now survive a page reload instead of resetting.

### Fixed

- Web UI: the Changes/Files panel used to only mount once a session actually existed, so opening it on a brand-new draft thread reserved its column and left the space empty instead of showing anything — it now always renders, with a "No session yet" state instead of a gap.
- Web UI: the Settings tab strip on narrow/mobile screens scrolls but gave no hint that SSH/Theme/Tools were reachable further right — added a fade at both edges.
- Web UI: `.modal-status`, `.modal-confirm`, and `.modal-share` were silently stuck at the same 480px width as every other modal — a stylesheet ordering bug meant their intended (smaller) widths never actually applied.

## 0.9.2

### Added

- Web UI: threads can now be shared as a public, read-only link (`/shared/<token>`) — no login required to open it, and it can be revoked at any time. The shared view never includes the persona's system prompt, only the conversation itself.
- Web UI: a "Quick session" button next to "New session" starts a fresh thread on a configurable default persona and a clean sandbox directory in one click, instead of going through the persona picker every time. The default persona is set in Settings → Tools.
- The favicon and browser tab title now match the app's actual identity — the tab reads "Cast" instead of "cast web", and the icon is the same pixel-block mark used in the app's own logo instead of a plain letter.

### Fixed

- Web UI: the sidebar's session menu (rename/share/delete) no longer opens off-screen for a thread near the bottom of a short or scrolled sidebar — it now opens upward when there isn't room below.
- Web UI: markdown links (`[text](url)` and bare URLs) in replies are now rendered as real clickable links instead of plain text.
- Web UI: the persona picker under "New session" is no longer clipped with no way to scroll to the rest of the list at high page zoom or with many personas — it now shares one scroll region with the session list instead of a second, cut-off one of its own.
- Web UI: the "Apply" checkmark next to a model/provider picker in Settings no longer stays active when nothing was actually changed, matching how every other picker in Settings already behaved.
- Web UI: a stopwatch tick during every running turn was re-rendering the entire app ten times a second, visible as flicker across the whole page; it's now isolated to just the composer's own elapsed-time display. Settings' model pickers also no longer flash between a cached and a freshly-fetched list on open.
- Web UI: the "not a git repository" message in the Changes panel no longer renders as one lopsided centered line — it's a proper two-line message now.

## 0.9.1

### Added

- Web UI: the final reply now shows a small, muted line with the provider, model, and response time — so a model switch is easy to confirm, and it's clear which model actually answered before deciding whether to switch again.
- The "Coder with subagents + forced review" persona was renamed to "Coder with mandatory review" for a more natural label.

### Fixed

- Web UI and TUI: providers that interleave content/reasoning deltas out of order mid-turn (observed on MiniMax-M2) no longer render as broken alternating "agent"/"reasoning" blocks with a word split across the seam — same-kind text now merges back together across the interruption.
- Web UI: switching the model (`/model`) now updates the sidebar immediately and becomes the default for every session created afterward — previously a new session always reopened on whichever model was active when the server started, no matter how many times you'd switched since.
- `bash`, `ssh`, and background bash now cap output at true UTF-8 bytes instead of JS string length, matching how `read` already worked — for non-ASCII text (e.g. Cyrillic) the old comparison let through roughly double the configured byte limit. The default cap was also raised from 64KB to 128KB.

## 0.9.0

### Added

- Build mode: a `todo_write` tool for tracking multi-step work as a checklist — persisted separately from the message history (survives compaction and process restarts), re-injected into the system prompt every turn, and enforced by the harness: after several tool calls with no list started, every further tool call is refused until `todo_write` runs. Not available in plan mode, which already has the plan checklist for the same job.
- Every persona's tool list now describes `todo_write` in its own voice — from qa's "one item per check in your verification pass" to architect's "rarely central here", matching how each persona already describes the rest of its tools.
- Web UI: code blocks in the chat now have a copy button (top-right of the block) that swaps to a checkmark on successful copy.

## 0.8.32

### Added

- Web UI: an MCP server row in Settings now has a Reconnect button (next to the pause/resume toggle), so a server that was fixed on disk (new URL/token) doesn't need a full server restart to pick it up.
- Web UI: the sidebar's message-count badges now update live for every thread, including ones you don't currently have open, instead of only refreshing on a full page reload.
- Web UI: the status popover ("i") now shows the active provider and how many tokens were served from cache.

### Fixed

- Web UI: numbered/bulleted lists with a blank line between items (common in model output) no longer render every item as "1." — each used to become its own single-item list.
- Web UI: runs of 3+ blank lines in a reply no longer render as an oversized gap between paragraphs.
- Web UI: opening a long thread no longer occasionally leaves the view short of the very bottom — the scroll-to-bottom jump is instant instead of an animated scroll that could lose a race with content still loading in.
- Web UI: streaming replies re-render at most once per animation frame instead of once per token, cutting the worst-case main-thread stall during a long, tool-heavy reply roughly 4x.
- Web UI: the status popover ("i") could fail to open entirely while the agent was running (reading the active provider was wrongly gated behind the same "must be idle" check as switching it).
- A turn cut short by the backend restarting no longer tells the model the user interrupted it — the reminder now says the server restarted instead of misattributing it.

## 0.8.31

### Added

- Web UI: sessions can now actually be deleted — the sidebar row's rename/close icons were replaced with a single ⋮ menu (also opens on right-click) offering Rename and a real, permanent Delete. Previously the × only unloaded a session from memory; it stayed on disk regardless.
- Web UI: a themed confirmation dialog now appears before closing/deleting a thread, matching the rest of the app instead of nothing at all.
- Web UI: new sessions default to a fresh sandbox directory instead of the project root — using the actual project root is now the deliberate choice.
- Web UI: the empty-thread "cast" banner is now a crisp SVG logo (larger than before) that recolors with the active theme, replacing the old ASCII-art text render.

### Fixed

- Web UI: closing a thread no longer leaves it as the fallback session when reopening the app with no `?session=` in the URL.
- Web UI: the Tavily/Brave Search API key fields are now masked, the "Save & use ..." button label no longer renders literally as `&amp;`, and a low-contrast hint line was removed.
- Web UI: the tool-call result expand/collapse arrow is now a proper icon instead of a tiny text glyph.
- Web UI: the streaming response no longer shows a blinking cursor (the composer's input caret is the only one now).

## 0.8.30

### Added

- `web_search` supports Brave Search as a third optional backend alongside DuckDuckGo (default) and Tavily. Unlike Tavily's AI-search aggregation, Brave is an actual general web index — a more direct drop-in replacement for DDG. Configure with `/web-search-provider` (TUI) or the Tools settings tab (`cast web`).

## 0.8.29

### Added

- `web_search` supports Tavily as an optional backend for anyone hitting DuckDuckGo's scrape rate limit (~4 requests per IP before a CAPTCHA blocks further searches) — Tavily's free tier is a recurring 1000 requests/month instead. Configure with `/web-search-provider` (TUI) or the Tools settings tab (`cast web`); DuckDuckGo stays the zero-config default.
- Web UI: tool call results are now expandable — click a tool card to see its full output (previously request-only), lazily rendered and capped at 64KB.
- Docs: a new research-grounded page on why persona/role framing changes agent behavior, linked from the personas doc and the landing page.

### Fixed

- `web_search`: an empty query or one over Tavily's undocumented 400-character limit no longer fails with an opaque HTTP 400 — empty queries are rejected with a clear message, over-length ones are truncated so the search still runs.
- `web_search`: the tool's advertised parameters now match the active backend — `region`/`time` (DuckDuckGo-only) are no longer offered to the model when Tavily is active, where they silently did nothing.
- GitHub Pages landing page and README: the ASCII banner no longer overflows or visibly snaps to size on narrow mobile viewports — replaced with a static SVG that scales like any other image.
- Docs: corrected two fabricated author citations in the persona-research motivation section.

## 0.8.28

### Fixed

- Web UI: reasoning text no longer mixes into the answer (with stray leading blank lines) when a provider streams `<think>...</think>` tags that split across chunk boundaries (MiniMax-M3 and similar) — the tag parser now buffers across chunks instead of scanning each one in isolation.
- Web UI: the composer's elapsed-time counter is now legible (accent color, larger) — it's the only signal that a still-running request is alive.
- `glob`: `**` now recurses into subdirectories instead of matching only the top level.
- `grep`: the no-`rg` fallback now matches `--glob` directory components correctly instead of only comparing basenames.
- `edit`: no longer corrupts CRLF files into mixed line endings; multiple `insert_after`/`insert_before` ops sharing one anchor now apply in the model's listed order instead of reversed.
- `write`: byte count in the tool result now reflects real UTF-8 byte length instead of JS string length.
- `read`: `limit: 0` is no longer silently treated as "no limit"; output is now also capped by byte size, not just line count.
- `ls`: symlinked directories are now classified as directories; missing/non-directory paths return a friendly message instead of a raw error.
- `web_search`: a cached query no longer permanently caps `maxResults` for later, larger requests against the same query.
- `web_fetch`: a request whose abort signal was already aborted before the fetch started is now aborted immediately instead of running to completion.
- `ssh`: a failure to spawn `ssh`/`sshpass` no longer crashes the whole process.
- Background bash tasks: a spawn failure no longer gets silently overwritten with a bogus "exited" status.
- The `task` tool no longer discards a subagent's usage/cost accounting when the subagent's loop throws.
- Ink TUI: the tool-call summary line now counts `insert_before` edits (previously always showed "+0 -0" for them).
- Plan mode: `plan_check` reliably matches real, markdown-formatted plan steps, including a step's own nested sub-bullets, regardless of exact wording.
- Plan mode: the "write a plan first" error from `plan_done` no longer references the removed `plan_write` tool.

### Changed

- Plan mode: writing, editing, and reading a plan file now goes through the normal `write`/`edit`/`read` tools (gated to the plan file's path) instead of dedicated `plan_write`/`plan_edit`/`plan_read` tools — one less parallel implementation to keep in sync.

## 0.8.27

### Fixed

- The `super-research` skill's description exceeded the 1024-character limit, logging a warning on every startup — it is now trimmed to a concise summary. Added a test that guards every builtin SKILL.md description against the limit so it can't regress.

## 0.8.26

### Added

- Web UI: Settings > Provider — a "Verify credentials" button probes the entered URL + key on demand, and credentials are now always verified before a provider is saved; invalid ones are rejected with the reason (auth / unreachable) shown inline. Backed by a new `POST /api/provider/verify` endpoint, matching the CLI add wizard's probe.

### Fixed

- Web UI: switching the active provider no longer leaves stale state — the model list refreshes immediately (no page reload needed), and the subagent/plan pickers no longer show a misleading "(inherits …)" hint for a model that isn't on the new provider. Selected models (main / subagent / plan) are reset on a provider switch since those ids belonged to the old endpoint.
- Web UI: the Model tab pickers now show a consistent "Pick a model…" placeholder for every slot, and the model name is no longer duplicated in the section titles.

### Changed

- Web UI: the Provider tab is now a clean list (add / edit / delete). The provider a model slot uses is chosen in the Model tab next to each slot, and subagent / plan now clearly inherit the main model's provider ("same as main") rather than referencing a vague "active (default)" concept. `/provider add` makes the first-added provider the active default so the main model works without a manual switch.

## 0.8.25

### Fixed

- Web UI: chat no longer flickers/remounts when toggling the diff panel, reconnecting, or reloading — an SSE reconnect effect was tearing down and rebuilding every message's DOM node on every diff-panel toggle and on every page load.
- Web UI: the saved theme now applies before first paint instead of flashing the hardcoded default accent while `/api/themes` is in flight.
- Web UI: personas/commands/themes/config are fetched once per tab instead of being re-fetched (and visibly re-flashed) on every SSE reconnect.
- Web UI: trimmed the cold-load waterfall — dropped an unused Inter font import that was blocking the whole JS bootstrap behind an external round trip, added `preconnect` hints, and a reload landing on `?session=<id>` now fetches that thread in parallel with the session list instead of after it.

### Added

- Web UI: Settings > Font — pick from 10 monospace and 10 sans-serif fonts (sans only affects interface text; code/tool output/tables stay monospace) plus a text-scale control (85%–150%), both applying instantly with no server round trip.

### Fixed

- Web UI: picking a persona for "+ New session" no longer creates a session on the backend right away — it stages a local draft and only creates the real thread on your first message, like ChatGPT's new chat. Abandoned drafts no longer leave permanent "0 msg" entries in the sidebar.

## 0.8.22

### Fixed

- Sandbox ("new") sessions now create their scratch directory under `~/.cast/sandbox/cast-<id>` instead of `/tmp/cast-<id>`, avoiding tmpfs permission and quota issues. The sidebar button is renamed from "tmp" to "new".

## 0.8.21

### Fixed

- Opening the directory picker after choosing "tmp" in the web UI sidebar no longer shows an ENOENT error — the picker is now only reachable for real, existing paths. The scratch directory for tmp sessions is created server-side at session-creation time and named after the session id (`/tmp/cast-<session id>`).

## 0.8.20

### Fixed

- New-session directory picker in the web UI sidebar now shows the current directory and the "tmp" option as a single segmented control, with the active choice highlighted — clearer than the previous cramped label+path+button row.

## 0.8.19

### Added

- "tmp" button next to the directory picker in the web UI sidebar — creates a `/tmp/cast-<id>` directory for throwaway sessions.

## 0.8.18

### Fixed

- Web server now defaults to `~` as the session working directory instead of the directory where `cast web` was launched. Use the directory picker in the UI to choose a project directory per session. TUI mode still uses the current working directory as before.

## 0.8.17

### Fixed

- Web UI Changes panel now shows all file types including untracked files (previously only tracked-file diffs were visible).
- `git diff --no-index` exit code 1 no longer silently drops untracked files from the diff response.

### Added

- Web UI Changes panel groups files by status: New files, Staged, Modified, Deleted, Renamed — each with a colored dot indicator and section count badge.

## 0.8.16

### Fixed

- Reasoning models that consumed the full `max_tokens` budget on thinking alone would silently fail. Now retries with doubled budget.
- Model validation incorrectly rejected reasoning models that return `reasoning_content` instead of `<think>` blocks.

### Added

- SQLite-backed session persistence — sessions survive restarts.
- Web UI scroll-up pagination for long conversations.
- Turn-accurate message counts in session metadata.
- Full session history preserved across context compaction instead of being pruned.

## 0.8.15

### Fixed

- Large tool results (big file reads, web fetches) could push a session past the context-compaction threshold mid-turn and only get caught reactively once the next model call overflowed. A new guard now compacts right after such a tool result lands, before the next call is made.

### Internal

- Unified the three compaction call sites (turn-start check, mid-turn guard, overflow retry) behind one shared helper to keep their message-splicing and event-emitting behavior in sync.

## 0.8.14

### Added

- Shared prompts adapted from MiMoCode: Doing tasks, Executing with care, Tone and style.
- Cast context prompt — all personas now know about cast-specific commands, rules, skills, and plan mode.

### Fixed

- Removed duplicate Action safety section from harness-discipline (now covered by Executing with care).
- Renamed cast from "coding agent" to "agent harness" to reflect all persona types.

## 0.8.13

### Added

- New builtin skills from MiMo Code:
  - `arxiv` — search, read, cite academic papers from arXiv
  - `deep-research` — parallel sub-agent research with cited reports
  - `frontend-design` — UI/UX design guidance
  - `learn-everything` — interactive learning from documents/PDFs
  - `super-research` — autonomous research experiments
- Updated `cast` skill with nested rules, apply modes table, and full commands reference.

## 0.8.12

### Fixed

- Web UI: `<system-reminder>` blocks (compaction, date-rollover, interrupt reminders) now render as styled warning messages instead of raw XML tags after session reload.
- Web UI: SSE reconnect — full state sync from server, stale streaming blocks cleared, auto-scroll to latest messages, visibility change detection for mobile tab switching.
- Web UI: message count in sidebar now shows only user and assistant messages (was inflated by hidden tool/system messages).
- Web UI: header "cast" text replaced with themed status dot indicator (green=connected, yellow=reconnecting, red=offline).
- Web UI: ASCII banner no longer overflows on vertical mobile screens — added `white-space: pre` and `max-width: 100%`.

## 0.8.11

### Fixed

- Mobile: ASCII banner no longer overflows on vertical phone screens — font-size reduced to 0.6rem on viewports ≤768px.

## 0.8.10

### Added

- Multi-provider per-model-slot selection: each model slot (main, subagent, plan) can now use a different saved provider. New commands `/subagent-model-provider` and `/plan-model-provider`. Web UI Settings shows cascading provider → model dropdowns for all three slots.
- Web UI: skill/plugin full content reader — book icon loads SKILL.md from disk and displays in a centered popover with scroll. Info icon shows short description.
- Web UI: skills grouped by source (Built-in, Global, Project, Plugin) with plugin ID shown for plugin-sourced skills. MCP servers grouped by source (Global, Project).
- Web UI: markdown table rendering in chat messages.
- Web UI: SSH key paste support — paste private key content directly in the SSH form, saved to `~/.cast/keys/` with 600 permissions.
- Web UI: provider edit support — edit button pre-fills URL/API key for modification.
- Web UI: `user_message` SSE broadcast — user messages from one tab appear in all other tabs viewing the same session.
- Web UI: new block-char ASCII banner (`░▒▓█`) for both TUI and web.

### Fixed

- `/reload` skips MCP reconnect when config unchanged — 2.7s → 27ms (100x faster).
- `/queue-reset` / `/qr` now clears pending queue badges in the web UI.
- ESC key closes info popovers before settings modal (proper layered close via `stopPropagation`).
- Markdown tables now render as `<table>` elements in web UI chat.
- Provider tab no longer crashes with `i.push is not a function` (htm `&&` → ternary fix).
- Models load instantly in Settings via `/api/models/cached` (no network call on open).
- All icon buttons use unified cyan hover accent; focus outlines removed.
- Pending steer (cyan) and queue (amber) items color-differentiated above the composer.

### Changed

- Web UI Settings modal: fixed height with scroll (no size jumping between tabs).
- Web UI: all text buttons replaced with verified Heroicons v2.1.5 icons with title tooltips.
- Web UI: `GET /api/models/cached` returns cached models instantly; `GET /api/models?provider=<name>` fetches from a specific provider.
- Web UI: SSH form fields stacked vertically with key paste textarea.
- Web UI: plugins show `plugin` name + `marketplace` as meta; skills show `name` + `source`/`pluginId` as meta.

## 0.8.9

### Added

- Web UI: real-time sidebar updates — status, title, and message count changes are now broadcast to all connected browser tabs via SSE `session_update` events, eliminating the need for manual refresh.
- Session summary index expanded with persona, model, title, pinned, and createdAt fields — cold session sidebar rows no longer require parsing full session JSON.
- JSONL session persistence — messages are now appended incrementally to `.jsonl` files instead of rewriting the entire session JSON on every mutation. Legacy `.json` sessions are auto-migrated to JSONL on startup.

### Fixed

- DECXCPR cursor-position queries (`\x1b[6n]`) no longer leak as visible escape sequences when stdin is not in raw mode (e.g. during `suspendTerminal`, tmux focus-out).
- `<Static>` items now use stable WeakMap-based keys instead of index-based keys — messages no longer disappear after compaction, steering injection, or session switch.
- TUI: StatusBar extracted into its own component with local 200ms tick — elapsed-time updates no longer re-render the Composer area.
- TUI: ChatLog wraps useWindowSize in its own component — resize events no longer cascade re-renders through the Composer.

### Changed

- Web UI: `session_end` SSE event carries usage and message count — the frontend only refetches the full session when message counts diverge (reconnect recovery), skipping the full `GET /api/sessions/:id` on normal uninterrupted runs.
- TUI: `/model`, `/plan-model`, `/subagent-model`, `/provider` use `refreshMeta()` instead of `refresh()` — no unnecessary message rebuild when only config metadata changes.
- `toDisplayMessages` uses O(M) Map lookups instead of O(N×M) `messages.find()` for tool result matching.
- TUI: `maxFps` reverted from 60 to 30 — double write frequency increased desync/flicker odds on slow terminals (SSH, tmux, mobile emulators).

## 0.8.8

### Fixed

- Web UI: page refresh during a running agent turn no longer loses the final assistant message — the `end` event now merges server-persisted messages into the client state.
- Web UI: pre-run save ensures the user's message survives a mid-run process kill (SIGTERM timeout, OOM, crash).
- Web UI: elapsed timer pauses when the SSE connection drops instead of counting up with a stale connection.
- Web UI: `status` event on SSE reconnect now refetches messages if the run completed while the client was disconnected.
- Web UI: `fetch()` and `EventSource` URLs now use `window.location.origin` explicitly to avoid cross-origin issues behind reverse proxies.

## 0.8.7

### Fixed

- Web UI static files (HTML, CSS, JS) now ship in release installs — `cast web` was returning 404 because `dist/public/` wasn't included in the archive.
- `cast web --foreground` correctly uses the specified `--port` instead of always defaulting to 1337.


## 0.8.6

### Fixed

- `cast web` daemon spawn now works in release installs (no longer requires `tsx` or TypeScript sources).
- `cast web --foreground` runs inline instead of spawning a child process.


## 0.8.5

### Added

- `cast web` now detects already-running instances and refuses to start a duplicate (instead of silently spawning a second server on the same port).
- `cast web --public` / `--host 0.0.0.0` — bind to all interfaces for network access (prints a security warning).
- `cast web stop` gracefully shuts down open sessions (SIGTERM), escalating to SIGKILL after 3s. Detects and cleans up stale state when the process is already gone (crash, OOM, `kill -9`).
- `cast web status` auto-heals stale PID files — reports honestly instead of claiming a dead process is running.
- Built-in `skill-creator` skill (user-invoked): reference for writing predictable skills, based on Matt Pocock's methodology (invocation modes, information hierarchy, leading words, pruning, failure modes).


## 0.8.4

### Added

- New shared prompt section (`verification-discipline.md`) instructs the agent to verify changes against the real running interface rather than trusting tests alone — appended to every persona and subagent prompt.

### Fixed

- Search tool (`grep`, `glob`) no longer blocks the Node event loop while `fd`/`rg` run — switched from sync to async subprocess execution, which matters under concurrent tool calls.

### Internal

- Eval harness restructured into `benches/` (basic, hashline, mutation) + `lib/` (runner, fixtures, results, trace-view).
- Eval runner now supports model comparison (`--compare`, `--compare-x3`) and trace replay (`--trace`).
- Added mutation bench for measuring tool robustness against prompt perturbations.
- Added eval methodology doc (`docs/eval-methodology.md`).


## 0.8.3

### Changed

- All persona prompts now consistently mention conditional tools (ssh, background bash) via the "go by your actual tool list" note — `coding.md` and `sre.md` were missing it.


## 0.8.2

### Changed

- Persona prompt tool lists no longer hardcode `ssh` — they now point the model at its actual tool list, so tools that are only conditionally available (ssh, background bash) aren't advertised when absent.


## 0.8.1

### Added

- **Background bash tasks**: the `bash` tool gains a `run_in_background` parameter (web and TUI only). Setting it to `true` spawns the command without blocking and returns a task id immediately. Completion arrives automatically as a `<system-reminder>` — no polling needed. Two companion tools (`bash_output`, `bash_kill`) let the agent check progress or terminate a task early. Background tasks survive across turns and are session-scoped; they're reaped on session close.


## 0.8.0

### Added

- **Web UI** (`cast web`): browser-based control room for managing background agents. Creates sessions with different personas, streams responses token-by-token, shows tool calls as terminal-style cards, and includes a resizable git diff viewer. Settings modal covers model/reasoning, theme, web tools, bash confirmation mode, and MCP/skills/plugins/provider/SSH management. Non-blocking slash commands (`/help`, `/current`, `/usage`) work while the agent runs. Keyboard shortcuts reference (`Ctrl+/` / `⌘/`) for sidebar, diff, new session, and clear-context. Auth with auto-generated password. Same sessions persisted to `~/.cast/sessions/` as the TUI.
  - `cast web` — start in background (daemon)
  - `cast web stop` / `cast web status` — manage the server
  - `cast web --foreground` — run inline for dev/debug
  - Default port 1337, configurable via `--port` or `CAST_WEB_PORT`


## 0.7.12

### Fixed

- Ink incremental rendering enabled (`incrementalRendering: true`) — only repaints lines that actually changed, reducing terminal traffic and eliminating flicker on frequent redraws. Frame rate cap raised from 30 to 60 FPS for a more responsive composer.



## 0.7.11

### Fixed

- Removed focus-reporting mechanism (`\x1b[?1004h`) that triggered a terminal resync on alt-tab: some terminals send focus-in reports unprompted, causing spurious screen clears that wiped the banner and broke the viewport. Focus in/out sequences are still silently dropped by the input parser so they never surface as stray characters.


## 0.7.10

### Fixed

- Autoscroll breaks after Alt+Tab: switching away from the terminal and back no longer leaves the viewport stuck — resync respects the current scroll position instead of force-resetting it.


### Changed

- Shift+Tab keybinding removed from Composer — simplified input handling, removed dead code from input-parser and keybindings.



## 0.7.8

### Fixed

- Terminal rendering corruption on Termius (mobile) and similar terminals: Ink's per-line erase sequence (`\x1b[2K\x1b[1A` repeated) is now coalesced into a single combined cursor-up + erase-to-end-of-screen before writing, preventing orphaned top-border fragments from stacking on every keystroke.



## 0.7.7

### Added

- `/continue` slash command — resumes the most recent session without leaving the current one. In-session equivalent of `cast -c`.

### Fixed

- Streaming output no longer overflows the viewport when the composer grows taller than the static budget estimate: ChatLog now shrinks its live-region budget reactively based on the actual last-frame overflow, so one bad frame self-corrects instead of repeating every frame.
- Composer ghost rows (streaks, duplicated borders) after deleting multi-line input: the frame now uses a sticky max height and pads back on shrink instead of letting Ink leave stale rows on screen.
- Synchronized-output flash on terminal resync (clear + replay): both writes are now wrapped in CSI ?2026h/l so the terminal buffers and swaps atomically.
- Resync no longer fires immediately after an aborted turn (Esc): the disruptive full clear + scrollback wipe lands on the next turn that actually completes instead.
- Reasoning and content block labels (`[reasoning]`, `[agent]`) no longer repeat on every split-off line of the same streaming run.
- Edit tool results no longer shown inline in ChatLog (same treatment as `read`).
- Composer re-renders on every stdin chunk even when nothing changed (DECXCPR responses, focus reports, partial escapes): now skipped unless the buffer value or cursor position actually moved.
- DECXCPR poll rate adapts: 200ms during streaming or when a resync is pending, 1s at idle to reduce unnecessary terminal traffic.
- Spinner render cycles reduced ~35% (120ms interval vs 80ms) with no visible quality loss.

### Internal

- `splitCompleteLines` drains completed lines from the trailing streaming block incrementally, giving the final answer the same steady commit cadence reasoning already gets.
- `useTerminalResync` scroll flags (`scrollUp`, `scrollUpStale`) reset after a resync clear, so the next Ink frame isn't swallowed by the scroll guard.
- Vitest `NODE_OPTIONS=--no-deprecation` suppresses the punycode warning from `openai -> node-fetch -> whatwg-url`.


## 0.7.5

### Added

- Personas travel with the thread: each session remembers the persona that drove it, and resuming (`-c`, `--resume`, `/sessions`) restores it — same rule as plan/build mode. The global setting remains the default for new sessions; a deleted persona falls back to the current one with a notice.
- Switching to a different persona (`/persona`) in a non-empty thread now offers to start a new session, so the previous persona's context doesn't bleed into the new role; "Continue here" / Esc keeps the current thread.
- Four new built-in personas rounding out the IT-company role set: `architect` (trade-off analysis, ADRs, module boundaries), `analyst` (requirements from vague asks, contradictions, API contracts), `sre` (incident response, blameless postmortems, SLOs), and `product` (hypotheses, success metrics, prioritization — distinct from the ticket-writing Project Manager).
- Built-in persona `coder-with-subagents-force-review` (Coder · forced review): same delegation as `coder-with-subagents`, plus a mandatory review gate — every code change goes through an independent `review` sub-agent (fresh context, diff-based input, execution-confirmed findings, exactly one round) before being reported done. No "too trivial to review" exception for code.

## 0.7.4

### Fixed

- Provider requests fail on Node 24 with "Cannot connect … (invalid content-length header)": the OpenAI SDK sets an explicit `content-length` header, which is a forbidden fetch request header — Node 24's undici rejects the request outright (Node 26 silently ignores it). cast now strips it and lets the runtime compute the value; model selection/chat work on Node 24 again.

## 0.7.3

### Fixed

- Windows: `cast upgrade` no longer crashes on exit with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — the hard `process.exit()` right after the release-check fetch raced libuv's handle teardown; the command now returns and lets the process exit naturally.

## 0.7.2

### Fixed

- "Cannot connect to <url>" errors now include the underlying network detail (`ECONNREFUSED` / `ENOTFOUND` / certificate errors, including ones buried in undici AggregateErrors) — DNS, dead-endpoint, and TLS-interception failures need different fixes and were indistinguishable.
- Windows: the Git Bash registry probe no longer leaks `reg.exe`'s localized stderr into the TUI as mojibake when the GitForWindows key is absent.

## 0.7.1

### Added

- Fuzzy search in the session picker (`--resume`, `/sessions`): type to filter by project path, session id, or any user/assistant message text in the thread; substring matches rank above subsequence (typo-tolerant) matches. `Esc` is the only cancel key while searching — `q` goes into the query.
- `write` replies with a line diff vs the previous content (plus trailing-newline notes) instead of a byte count; new-file and identical-content cases are reported explicitly.
- `write` and `edit` warn when the resulting file contains consecutive identical lines — the classic symptom of a duplicated-line botch.
- `edit` auto-recovers a stale anchor that matches a run of contiguous byte-identical duplicate lines (they're interchangeable), instead of dead-ending with "multiple lines match".
- Windows: the `bash` tool locates a native Git Bash (CAST_BASH env override → GitForWindows registry key → known install paths incl. no-admin and scoop → derivation from `git` on PATH) instead of picking up the WSL shim from PATH, which loses output. Falling back to PATH bash warns at startup and in the first tool result.
- Session summary index (`~/.cast/sessions/index.json`): the picker lists hundreds of sessions from an mtime-validated cache (~5ms warm) instead of parsing every session file; the full session is parsed only for the one you pick. Self-healing — safe to delete.
- `cast -c` finds the most recent session by file mtime and parses only that file (was: parse everything).

### Fixed

- Prompt-cache markers (`cache_control`) no longer leak into saved sessions: `applyCacheControl` works on request-only copies, and loading normalizes sessions damaged by older builds — fixes opaque 400s ("Can only get item pairs from a mapping") when resuming after a provider switch.
- Resuming a session created on a different provider falls back to the currently configured model (with a notice) instead of sending requests to a model the new provider doesn't serve.
- Tool-call arguments that are valid JSON but not an object (e.g. a bare array) are wrapped before sending, so providers whose chat template iterates arguments as a mapping don't reject the whole history.
- Stdio MCP servers inherit cast's full environment (config `env` wins) — shell-exported API keys now reach servers; the SDK's whitelist default silently stripped them.
- Remote MCP servers that only speak the legacy HTTP+SSE transport now connect: Streamable HTTP is tried first, then one SSE retry on rejection. SSE JSON-RPC POSTs run on a dedicated connection pool — the long-lived `/sse` stream otherwise serializes them behind itself in Node's fetch and the handshake hangs forever.
- SKILL.md / persona / rules frontmatter survives a UTF-8 BOM (Windows Notepad, `Out-File`); previously the whole frontmatter was silently discarded.
- Plugin marketplace commands report "git is not installed or not in PATH" instead of a raw `spawn git ENOENT`; staging directory names derived from Windows local paths no longer contain `\` or `:`; marketplace install retries `rm`/rename against transient Windows EPERM/EBUSY locks.
- `getMostRecentSession` skips a corrupt (half-written) newest session file and falls back to the next one.
- `bash` tool reports a clean error when the bash executable itself can't be spawned (e.g. a wrong `CAST_BASH`), instead of hanging.

### Changed

- Docs: provider credentials are configured only via `~/.cast/settings.json` / `/provider` — the `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` environment variables were documented but never read; the docs no longer claim otherwise.
- Minimum Node.js version raised from 18 to 22 (required by undici 8.x used for MCP SSE transport).

## 0.7.0

### Added

- After compaction (auto or `/compact`), cast injects a separate trailing `<system-reminder>` user message with edited files and a TODO list of open plan steps. Steps come from `- [ ]` checkboxes when present, otherwise from `###` headings under `## Steps` (common in real plans). Omitted when there is nothing actionable; summary text stays reminder-free.
- Turn-end open-work gate in build mode with an active plan: if the model stops without tool calls while plan steps remain open, cast injects a `<system-reminder>` and continues sampling (up to 2 times per user prompt, then falls through with an exhausted notice).
- After a mid-stream `/abort` (Esc) with no tool-result abort signal, cast appends a `<system-reminder>` (`[Request interrupted by user]`) so the next turn’s model sees that the prior turn was cut off.
- Overnight sessions get a one-shot `<system-reminder>` when the local calendar date advances past the last announced day (persisted per session).
- Built-in `explore` and `review` subagents for `task` (read-oriented tool allowlists). `coder-with-subagents` steers mapping to `explore` and validation to `review`; `worker` remains the default catch-all for everything else.
- Marketplace plugins (Grok/Claude-shaped): `/plugin marketplace add`, `/plugin install name@marketplace` — installs contribute skills from `~/.cast/plugins/`.
- `/skills` and bare `/plugin` open multi-select toggles (same UX as `/mcp`); disabled skill names persist in `disabledSkills`.
- Default marketplaces auto-seeded once: Codex (`openai/plugins`), Claude (`anthropics/claude-plugins-official`), Grok (`xai-org/plugin-marketplace`).
- `/plugin` slash palette lists install / marketplace / toggle subcommands; builtin `cast` skill documents plugins + toggles.
- Bare `/plugin uninstall` opens a picker + confirm (typed `name@marketplace` still works).
- `/skills uninstall` and `/mcp uninstall` — interactive picker + confirm (or typed name); removes global/project skills and mcp.json entries, clears matching disable flags, hot-reloads.
- Uniform `/skills` / `/mcp` / `/plugin` surface: `list`, `enable`/`disable`, `help`; toggle cancel shows `[Cancelled]`; no-op toggle skips reload; typed uninstall confirms; `/plugin marketplace remove` cleans settings + reloads skills.
- Skill discovery loads skills.sh universal paths: `.agents/skills/` (project, trust-gated) and `~/.config/agents/skills/` / `~/.agents/skills/` (global), so `npx skills add … -a universal` works without copying into `.cast/skills/`.
- `/skills`, `/mcp`, and `/plugin` pickers/lists sort entries alphabetically by name (skills were previously discovery-order, so plugin skills clustered at the bottom).
- `/skills` labels plugin skills with their pack id (`plugin · name@marketplace`). Skills from a disabled pack stay visible but locked (muted) until `/plugin` re-enables the pack.
- `/skills uninstall` lists plugin skills as muted/locked (remove the pack via `/plugin uninstall`); Enter on those rows is ignored.

### Fixed

- `read` tool rows show the correct 1-indexed line range (was off-by-one when `offset` was set).
- Live-region `task` rows stay one-line (truncate) while streaming so parallel tasks remain visible; full wrapped assignment still shows once promoted to history.
- Committed `task` tool rows show the full subagent report (wrapped), not a 500-char truncated line.
- Session rebuild/resume restores tool `[error]` via persisted `castIsError` on tool results (was always `[ok]`).
- Trackpad scroll during an active agent turn no longer fights Ink redraws: while the live region fits the screen, cursor-position polling stays on (and short CUU frames cannot clear the scroll-up guard); tall streaming frames skip that poll so a false scroll latch cannot swallow redraws and scramble scrollback.
- Sync `task` subagents honor parent `--no-skills` / `--skill` (they previously always loaded global/builtin/plugin skills and ignored CLI skill paths).

### Changed

- Docs spell out hot-reload vs `/reload`: `/skills` / `/mcp` / `/plugin` toggle and install/uninstall apply in-session; `/reload` is only for on-disk file drops/edits (same chat, no restart).
- `/skills` / `/mcp` / `/plugin` pickers put the full description on the focused second line (wrap), not truncated into the label.
- `task` UI shows the delegated assignment text (not raw JSON `key=value` args). Non-default subagent names are prefixed (`explore · …`).
- Subagent final-answer extraction ignores empty placeholder turns (`(no response)`); the worker prompt requires a standalone closing report.
- Sync `task` subagents now receive the same environment grounding as the parent: Current System State (cwd/date/platform/model), always-apply + lazy rules, skills catalog, MCP server list, and SSH hosts.
- `--no-skills` help/docs clarify that plugin skill discovery is skipped too (behavior unchanged).
- `coder-with-subagents` (and the `task` tool description) steers harder on user cues like “parallel” / “independently”: split into same-turn multi-`task` calls instead of solo exploration.
- Shared prompt append adds Agent discipline (action safety, parallel tool calls, preamble-with-tools, prompt secrecy) for all personas and subagents.

## 0.6.12

### Changed

- Renamed the file-search builtin from `find` to `glob` (same glob-pattern behavior). Legacy `find` calls and `tools: [find, …]` allowlists still work.
- Shared file-tool guidance steers named-file tasks to `read` first; short `glob` results remind the model to `read` a hit instead of another search/`ls`.
- `edit` `insert_after` accepts anchor `EOF` to append at the end of a file (alongside existing `0:` for the top).

### Fixed

- `edit` recovers unique hash-only anchors when the model omits the line number (`local:chunk` instead of `22:local:chunk`), and accepts ASCII `->` gutters the same way as `→`.
- Shared file-tool guidance (all personas **and** subagents) now spells out the read→edit workflow: known path skips `glob`, one `edit` per file, copy the full three-part anchor, retry from tool-returned anchors instead of re-searching.
- When `read`/`edit` miss a path, cast runs a basename `glob` under the hood and lists real matches so the model can retry the correct path without starting its own search loop.

## 0.6.11

### Added

- Persona and subagent frontmatter support `tools` (builtin allowlist; exact names or `*`-globs like `plan_*` / `web_*`) and `agentsMd` (default `true`). Omit `tools` for all builtins; MCP tools are never filtered by the allowlist. Session gates (plan/build mode, web toggle) still apply on top.

## 0.6.10

### Fixed

- `edit` returns edited regions with fresh anchors on success, so a follow-up edit on the same file no longer needs a re-read after lines shift under prior anchors.
- `read` output was switched from the two-part `<LINE>:<HASH>→` anchor format to the three-part `<LINE>:<LOCAL>:<CHUNK>→` format (introduced during the 0.6.9 cycle). The three-part form gives finer-grained movement detection when lines shift around, and the stale-anchor error path now returns a fresh anchor instead of failing blind.

## 0.6.9

### Added

- `edit` now accepts `insert_before` to add new lines above a target anchor (in addition to the existing `insert_after`). Useful when the natural reference is a heading you want content to sit *above* rather than below.
- Successful `edit` operations now return the edited regions with fresh anchors, so a follow-up edit doesn't need a re-`read` even when prior anchors shifted.

## 0.6.8

### Changed

- **Hashline anchor format switched from `<LINE>:<HASH>` to `<LINE>:<LOCAL>:<CHUNK>`** for `read`/`edit`/`grep` output. The three-part form gives finer-grained movement detection when lines shift around, and the stale-anchor error path now returns a fresh anchor instead of failing blind. Anchors emitted under 0.6.7 are no longer valid; re-read the file to get anchors in the new format.

### Fixed

- `parseAnchor` now ignores any content past the `→` separator, so pasting a `read` gutter line (with its arrow and trailing content) into `edit` produces the correct anchor instead of a malformed one.

## 0.6.7

### Changed

- **`read` output now carries hashline anchors** in the form `<LINE>:<HASH>→content` so a line reference made in one assistant turn still points at the same line after a re-read; `edit` accepts `replace` / `insert_after` / `write` operations keyed by those anchors and validates the whole batch atomically against the current file (stale anchors return fresh anchors instead of failing blind).

### Internal

- Per-line hash computation for `read`/`edit`/`grep` is now backed by an in-memory LRU (default 20 entries, ~4 MB worst case). Entries are re-validated against file `mtime` on every access, so cache hits silently invalidate after external edits.
- `Lru` exposes a `size` getter so the test-only `hashlineCacheSize` no longer reaches into a private field.

### Internal

- `read`/`edit` now emit and accept hashline anchors (`<LINE>:<HASH>→…`) so line references in the conversation survive re-reads; edits are validated atomically against the file as it stands at edit time
- In-memory LRU (default 20 entries, ~4 MB worst case) caches per-line hashes for `read`/`edit`/`grep`; entries are re-validated against file `mtime`, so cache hits silently invalidate on external edits
- Added a public `size` getter on the LRU so `hashlineCacheSize` no longer reaches into a private field

### Changed

- **`/current` model line shows the configured model and the live plan model together** when plan mode swaps in a separate one, so the discrepancy from the status bar becomes visible instead of silently different.

### Internal

- `/current` rendering moved into `formatValue` on each registered status bar segment — adding a new segment now needs one place instead of two.
- `applyProviderSelection` extracted from `/provider activate` — the post-save flow (`selectModel` → `selectReasoningLevel` → `refresh`) lives in one helper. `/provider add` keeps its own notice wording and stays inline.
- `/current` and `/usage` reuse `abbreviateTokens` and `formatContextPct` from `App.tsx` — local `fmtK` (no M-branch) and a duplicated context-percent formatter are gone.
- Hermes XML strip is a single function (`stripHermesToolCalls`) shared by `core/llm.ts` and the streaming path — the previously duplicated private copy was deleted.
- `ensureConnectionAlive` now writes the full providers array (not just legacy `providerUrl`/`apiKey`); the regression test was tightened to assert exactly what gets persisted, including that existing providers survive a reconnect prompt.
- New `test/statusbar.test.ts` covers `defaultStatusBarConfig`, the `SEGMENT_MAX_WIDTH` overflow map, and the empty-data paths of the registered renderers; new `formatValue` tests cover the plan-mode model divergence.

## 0.6.5

### Added

- **Multi-provider support** — `/provider` now opens a picker to switch between saved providers; `/provider add` adds a new provider (name → URL → key wizard); `/provider delete` removes one. Providers persist in `settings.json` and the active one is remembered across sessions.

## 0.6.4

### Fixed

- **Hermes tool-call recovery** — XML `<function=…>` blocks in assistant prose (e.g. the model describing the feature itself) are no longer mis-parsed as live tool calls, preventing `400 Param Incorrect` loops on the next request. Recovery and dedup-strip now gate on actual tool names from the current session.

## 0.6.3

### Fixed

- **Streaming dedup** — Hermes models that emit both XML `<tool_call>` blocks and native function-calling in the same response no longer produce duplicate tool invocations

## 0.6.2

### Added

- `/statusbar` command — toggle, reorder, and reassign status bar segments between left/right sides via an interactive picker. Config persists across sessions. Useful on narrow/mobile terminals where the full bar overflows. Default: persona, mode, model (left) and elapsed (right); toggle others via `/statusbar`.
- `/current` command — show all status bar data in a list, including disabled segments

## 0.6.1

### Fixed

- **Terminal resync** — resize and focus-regain now use a light clear that preserves scroll position; theme changes and streaming desyncs still do a full scrollback wipe
- **lineChurn** — O(m·n) fallback for large edits uses Set-based comparison instead of raw block count; identical large texts no longer report false positive changes
- **Input parser** — DECXCPR cursor-position responses (`\x1b[row;colR`) explicitly dropped to prevent accidental keybinding matches

### Internal

- `displayWidth` extracted to `src/ui/display-width.ts` with per-session cache
- Test directories isolated to prevent parallel test collisions

## 0.6.0

### Added

- **SSH tool** — run commands on remote hosts via SSH; hosts configured in `~/.cast/ssh.json` (global) or `.cast/ssh.json` (project)
- `/queue-reset` alias — shortcut for clearing the command queue

## 0.5.8

### Added

- MCP server toggle — `/mcp` now opens an interactive multi-select picker to enable/disable individual servers mid-session. Disabled servers are hidden from the model and persisted in settings.
- `<available_mcp>` block in the system prompt — the model sees only enabled MCP servers and their tools, and will not attempt to call disabled ones.
- Hermes XML tool-call parsing and recovery
- Terminal desync tracking with automatic resync on focus return

## 0.5.7

### Added

- Enhanced search functionality with permission handling and output notes
- Improved tool name sanitization to prevent doom loops

## 0.5.6

### Fixed

- Terminal tools (`plan_done`, `plan_enter`) now force-end the turn — prevents the model from keeping runs alive by rewording summaries to dodge the doom-loop detector
- `plan_done` no longer echoes full plan content into model context, which invited endless "refinement" loops

## 0.5.5

### Added

- Changelog page with version history from 0.1.0 to 0.5.4
- Sequential prev/next navigation on all documentation pages (reading loop: Getting Started → ... → Changelog → Getting Started)
- `/usage` command documented in README and interactive commands reference
- Plan mode refine option uses the regular composer (multi-line and image paste supported)

### Fixed

- Improved provider error classification — OpenAI SDK `APIConnectionError` cause chain is now fully traversed for accurate error reporting

## 0.5.4

Fix: ensure non-negative token counts in usage tracking and streaming.

## 0.5.3

Fix: `/usage` now correctly shows sub-agent token breakdown.

## 0.5.2

### Added

- `/usage` command — show cumulative session token/cost usage
- `/exit` command — alias for `/quit`

## 0.5.1

### Changed

- Repositioned cast as a "role-based agent harness" — 13 built-in personas, same tools, different judgment

## 0.5.0

### Added

- **Plan mode** — `/plan` enters a read-only exploration phase; the agent studies the codebase and writes a structured execution plan with a checklist
- Plan tools: `plan_write`, `plan_edit`, `plan_read`, `plan_done`, `plan_discard`, `plan_enter`, `plan_check`
- Per-phase model support — `/plan-model` sets a separate model for planning vs building
- Plan files persist as markdown in `~/.cast/plans/`; survive compaction and session restarts
- Approval dialog: implement now, clear context + implement, approve for later, or refine
- E2E smoke test for plan mode

### Changed

- Comprehensive documentation overhaul — all features now documented in `docs/`

## 0.4.7

### Added

- Improved picker viewport handling with scrolling and index clamping
- 8 new dangerous bash patterns (fork bombs, `shutdown`, `npm publish`, `killall`, etc.)

## 0.4.6

### Changed

- Enhanced dangerous command detection in permissions

## 0.4.5

### Changed

- Removed interactive command checks from permissions (simplified)

## 0.4.4

### Added

- **Web tools** — `web_search` (DuckDuckGo) and `web_fetch` (Jina Reader) for internet access
- Web tools are off by default; toggle with `/web` (persists to settings)

## 0.4.3

### Added

- **Doom loop detection** — blocks a tool after 3 identical consecutive calls with the same arguments

### Fixed

- Streaming viewport clamping and scroll position issues

## 0.4.2

### Added

- `/copy` command — copy last assistant response to clipboard

### Fixed

- Scroll position not resetting on resync while user is scrolled up

## 0.4.1

### Fixed

- Atomic writes for session and settings files (prevents corruption on crash)
- Session listing and MCP connect timeout hardening
- Clear error on missing required prompt files
- Persona sorting uses label instead of name

### Changed

- Split `tools.ts` into per-tool modules (`bash.ts`, `files.ts`, `search.ts`, `web.ts`, `task.ts`)
- Centralized prompts directory resolution

## 0.4.0

### Added

- Multi-source personas — project-local, global, and builtin with priority ordering
- Sub-agent support via the `task` tool — delegate work to isolated sub-agents
- `coder-with-subagents` persona

## 0.3.17

### Added

- Brace expansion in glob patterns
- Enhanced gitignore handling

### Changed

- Agent loop and UI performance tracking improvements

## 0.3.16

### Added

- **Non-interactive mode** — `cast run` sends a single prompt, streams to stdout, exits
- `--format json` for structured JSONL output

## 0.3.15

### Added

- `/repo` command — show cwd, git branch, dirty state, remote, and HEAD
- Multiple color themes (16 total)

## 0.3.13

### Added

- Theme support — `/theme` picker, persisted to settings

## 0.3.12

### Fixed

- Made node-pty optional with pipe fallback for release bundles

## 0.3.11

### Added

- PTY for bash commands — captures interactive prompts (e.g. `npm init`)

## 0.3.10

### Fixed

- Live bash command reveal only when waiting for input

## 0.3.9

### Added

- Re-pick model when provider token changes at startup
- Custom model id entry in picker
- Surface actionable turn errors (revoked key, quota exceeded, no access)
- Recover from dead provider connection at startup
- Esc stops the running turn; Ctrl+C exits with confirmation

### Fixed

- Provider key persistence on re-entry
- Distinguish aborted, disconnected, and completed turns at stream end

## 0.3.8

### Changed

- Streaming and rendering logic overhaul for chat messages

## 0.3.7

### Added

- StdinManager for handling interactive input in child processes

### Changed

- Streamlined session handling

## 0.3.6

### Fixed

- Inline model context windows map (removed external JSON file dependency)

## 0.3.5

### Changed

- Documentation updates

## 0.3.4

### Fixed

- Message sanitization and tool call handling

## 0.3.3

### Fixed

- `/steer` behavior when idle (now submits as normal prompt)

## 0.3.2

### Added

- Paste chip functionality in Composer
- Command aliases: `/s` for `/steer`, `/q` for `/queue`
- Nested context file resolution (AGENTS.md in subdirectories)

## 0.3.0

### Added

- **Rules system** — Cursor-compatible `.cast/rules/*.md` with always/auto/lazy/manual modes
- `@rule-name` mentions in messages
- Chat log display improvements (clampTailToRows)

## 0.2.3

### Added

- System state block in system prompt (model, reasoning, cwd, git branch)

## 0.2.1

### Added

- `/keys` command — list all keybindings

## 0.2.0

### Added

- Multi-source personas (project > global > builtin)
- Built-in skills
- Cast meta-skill for self-configuration

## 0.1.4

### Fixed

- Token count abbreviation in status line (8.7k, 1.2M)

## 0.1.3

### Added

- `/model` highlights current selection in picker
- Honest reasoning display

## 0.1.2

### Fixed

- `reasoning_content` field support
- Resize reflow
- Tool call summaries
- `/steer` and `/queue` validation

## 0.1.1

### Fixed

- ThinkBlockParser off-by-one
- Added QA personas and vendors tests

## 0.1.0

Initial release. Ink TUI, 13 built-in personas, OpenAI-compatible provider, session persistence, context compaction, MCP servers, skills, parallel tool execution, sub-agents.
