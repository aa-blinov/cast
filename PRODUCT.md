# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal

The schema's values are web, ios, android and adaptive, and none of them fits the primary surface. cast is a terminal application: the full-screen interface in `src/ui-pi` is drawn in a character grid on `@earendil-works/pi-tui`. The browser client in `src/server/public` is a second surface of the same product rather than a different one, and `cast run` is a third.

The runtime is Node.js 22.12 or newer. The product ships as a self-contained bundle with its required runtime packages for macOS x64 and arm64, Linux x64 and arm64, and Windows x64 and arm64.

## Users

The owner recorded the primary user: developers in long working sessions. Hours in a terminal, locally and over ssh or tmux, with the screen next to an editor. They read a lot of text and code, switch personas, and run turns that take seconds to minutes. Terminal themes, colour depth and window sizes vary.

The browser surface serves the same person in a different situation: sharing a session, keeping one running in the background while the terminal is closed, or driving cast from a phone. The README is written in English for whoever found the link, and the repository is public.

The team, the audience beyond developers, and the size of any of this are not recorded. The evidence on hand is a public repository with a release history, and no usage numbers.

## Product Purpose

cast is a coding agent for the terminal and the browser: a loop that reads, edits and runs things in a repository, with sessions, memory, skills and MCP around it. The terminal screen is where the work is watched and steered.

The loop is the product. The model streams its answer as it is produced, the tool calls run, the results come back, and the next turn starts from what the last one learned. Around that sit the things that make the loop usable over hours: a session that survives a restart, memory that survives a session, and a way to change the agent's judgment without changing the tool surface.

Success for the user: the change is made and the reasoning behind it is on screen, without the person leaving the terminal to set anything up. Success for the product: the same session is reachable from a browser, the work continues in the background, and the answer is the same one the terminal would have given.

## Positioning

One engine, an agent with a character chosen for the task: Senior Developer, Planner, Reviewer, Analyst, Researcher, Assistant, Coder with subagents. The owner confirmed personas and a lazy senior as the thing neighbouring agents cannot honestly copy. The defaults are root-cause fixes and deletion over addition.

Two things make it more than a prompt. The character is a file, and the capability limits in it are enforced where the calls happen: the loop refuses a tool the persona is not allowed to use, rather than trusting the instruction not to make it. And the tool surface is otherwise unchanged, so changing a role does not quietly remove a workflow the person relies on. Only the `coder-with-subagents` persona turns on delegation, because a tool that appears and disappears with the role is a workflow that breaks.

The second difference is the surface. The same session runs in a terminal, in a browser and from a shell, with the daemon as the single writer, so the answer does not depend on where it was asked for.

## Operating Context

Alternate-screen terminal interface with app-owned scrolling: the conversation, a composer, a one-row status bar, and modal overlays for the pickers, the settings, the status-bar editor and the live subagent view. It works from 40 to 200 or more columns.

The work happens in the foreground, in the terminal, while the person watches. A turn can take minutes, so the screen has to be readable at a glance and the transcript has to be navigable without leaving it. The wheel, the trackpad, PageUp, PageDown and search all move through the conversation, and a repaint does not drag it back to the bottom.

Behind the screen, the daemon holds the loop and the session store. It survives the terminal closing, so a session opened in the browser is the session the terminal was working on.

## Capabilities and Constraints

Confirmed by the code:

- Seven built-in personas ship in `prompts/personas/`: `analyst`, `assistant`, `coder-with-subagents`, `pm`, `qa`, `researcher` and `senior`, which is the default.
- A persona's `tools`, `skills`, `mcp`, `subagents` and `subagentTypes` allowlists are enforced in the loop, and the `skills` and `mcp` limits also apply to anything the persona delegates.
- Capability scoping is opt-in. A persona without an allowlist keeps every built-in tool.
- One engine, `runAgentLoop` in `src/core/loop.ts`, serves the terminal screen, the browser and `cast run`.
- The daemon is the only writer to the session store, at `~/.cast/sessions/sessions.db`.
- Read-only tool calls inside one assistant message run concurrently when they are on the parallel-safe list (`glob`, `grep`, `lsp`, `ls`, `memory`, `session_history`, `web_search`, `web_fetch`, `bash_output`); shells, writes, `task` and MCP calls run in call order.
- The doom-loop detector blocks a tool after 3 identical calls inside a window of 12.
- Compaction starts at 0.75 of the usable input budget. The default reply reserve is 32000 tokens, capped at half the window.
- A turn stops after 500 model calls by default, and the work done so far is already persisted.
- The web tools are off until `/web` turns them on, and while they are off they are not advertised to the model at all.
- The Web chat uses Monos UI's panel, message and composer components around Cast's existing session, streaming and tool rendering. The terminal keeps its pi-tui interface over the same engine.
- The Web client is a PWA. The service worker caches static app assets for offline loading; API requests and event streams still need a connection. Remote installs need HTTPS because `--public` serves plain HTTP.
- Dangerous shell commands ask first. The file tools never ask, because git undoes them.
- Permission rules resolve in one order: deny beats approved, approved beats ask, ask beats allow.
- The `bash` timeout is in milliseconds, 180000 by default and 3600000 at most.
- Sandbox sessions run the shell process tree under OS isolation: writes are confined to the session folder and a private temp folder, home-directory reads and credential files are denied, and network access is blocked by default. Linux needs bubblewrap, socat and ripgrep; macOS needs ripgrep; Windows support is alpha and needs a one-time elevated install. Built-in file tools use cast permissions, and MCP server processes stay outside this shell boundary.
- `/cost-cap <USD>` sets a cumulative per-session threshold from provider-reported prices across main calls, compaction, hooks, memory upkeep and subagents. Unknown prices block later requests while the cap is on; because price is reported after a call, the call that crosses the cap may exceed its remaining amount.
- A `web_fetch` through the Jina backend refuses a private or internal address and a URL with a login in it.
- The daemon's local token is accepted only from a loopback socket, even when the daemon is bound publicly.
- Every rendered line has to fit the width.
- The colour depth varies between truecolor, 256 and none, and `NO_COLOR` is honoured.
- The text colours are held to 4.5:1 against the background they sit on.
- The copy is short, dry, and free of emoji.

Deliberately not true, and worth knowing before a change:

- The release archives carry no signature and no checksum file: the release workflow uploads the tarballs as they are, and the installer fetches them over HTTPS without verifying a digest.
- There is no automatic update. `cast upgrade` re-runs the installer.
- The OS process sandbox applies to shell commands and their children, not to already-running MCP servers. Its Windows backend is alpha and requires a one-time elevated machine setup.
- `--public` serves plain HTTP, so it protects nothing on a network the machine does not trust.
- The full-screen interface needs a terminal. In a pipe or in CI, `cast run` is the path.
- The project memory write is best-effort: a failing writer leaves the conversation successful and reports a warning.

## Brand Commitments

None carried over: the owner said the current look (palette, gradients, rails, labels) may change freely. The name `cast` and the dry, short voice of the copy are the only constants in the code.

The interface states the outcome in words rather than relying on a colour. A failed command says it failed, a finished one says what changed, and the status line names the persona, the model, the mode and the context it is in.

## Evidence on Hand

- `README.md` describes the flow, the personas, the server and the settings.
- `docs/` holds thirty-one Markdown documents, one subject each, from the architecture and the infrastructure to the terminal screen and the web client, plus three performance baselines under `docs/perf-baseline/`.
- `src/core/loop.ts` holds the engine, `src/core/personas.ts` the loader, and `prompts/personas/` the seven built-in personas.
- `test/` holds 234 vitest files, named after the module they cover, and `evals/results/` holds the committed behaviour eval runs with `docs/eval-scoreboard.json` as the scoreboard.
- `DESIGN.md` holds the visual system and `PRODUCT.md` holds this record.
- The owner records that real screens exist as tmux captures. None of them is committed to the repository; the only image in the tree is `assets/cast-banner.svg`.

Absent, and not to be invented: no download counts, no usage numbers, no testimonials, and no comparison with other coding agents. The repository description says "20 built-in personas"; `prompts/personas/` ships seven, so the discrepancy is in the description and not in the code.

## Product Principles

1. Legibility over ornament: the reader spends hours on this screen.
2. The agent's character shows in behaviour and wording, not in decoration.
3. Quiet by default: colour and emphasis mark state and role, nothing else.
4. Works everywhere: width, colour depth and terminal quirks degrade gracefully.
5. One engine, one writer: the daemon owns the loop, and each surface renders its event stream instead of re-deriving the state for itself.

## Accessibility & Inclusion

- Contrast floor of 4.5:1 for text, and meaning never carried by colour alone: a mark or a word goes with it.
- `NO_COLOR` is honoured, and the layout survives on a terminal that is not UTF-8, where the box and arrow glyphs become ASCII.
- The whole terminal interface is keyboard-driven, and the screen is checked at 46 columns and at 100.
- The browser client is built for a phone: the sidebar becomes a drawer under 768px, and every control has a 44px target.
- A formal accessibility standard has not been set for the project, and no audit has been recorded. The contrast floor and the shape-alongside-colour rule are the working rules.
