# Development Rules

## Conversational Style

- Short, direct, technical prose. No emojis.
- Answer the user's question before making edits or running commands.
- When responding to feedback, say whether you agree or disagree before describing the change.

## Code Quality

- Read a file in full before making wide-ranging changes to it.
- No `any` unless truly unavoidable.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for real external API types/signatures; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`) — top-level only.
- Never remove/downgrade code to silence a type error from an outdated dep — upgrade the dep instead.
- Always ask before removing functionality that looks intentional.
- Comments explain *why*, never *what*.

## Project Layout

The npm package is `cast`, but source lives directly under `src/` (no wrapping `cast/` dir).

**Source code** — always `src/`:
- `src/core/` — engine (no UI): loop, tools, LLM, session, config, MCP, skills, personas
- `src/ui/` — Ink TUI: App, ChatLog, Composer, commands, input handling
- `src/pickers/` — onboarding pickers (model/persona/reasoning selection)

**Other top-level dirs** — not source code:
- `prompts/` — system prompt, persona, compaction markdown files
- `test/` — vitest, one `test/<module>.test.ts` per `src/<module>.ts`
- `evals/` — regression eval runner (not part of the main application)
- `bin/` — published CLI launcher
- `scripts/` — esbuild bundle step

When the user asks about "code", "source", "сколько кода", or similar — they mean `src/`. Never navigate to `evals/`, `test/`, or `scripts/` unless explicitly asked.

## Commands

Always run in this order before committing:
1. `npm run check` — `tsc --noEmit && biome check src/ test/`
2. `npm test` — full vitest suite
3. `npm run build` — bundles into `dist/index.js` via esbuild

Other:
- `npm run format` — `biome format --write` (tabs, width 3, 120-col)
- `npx vitest run test/<file>.test.ts` — run one test file

## Testing

- Framework: vitest, one `test/<module>.test.ts` per `src/<module>.ts`.
- No real LLM/provider API calls — use mock configs with a fake `baseURL`/`apiKey`.
- MCP tests are the one exception: `test/mcp.test.ts` spawns a real local test-fixture server.
- Tool tests use `test/__test_tmp__/`, created in `beforeEach`, removed in `afterEach`.
- After adding/changing a tool, skill, persona, or MCP behavior: add or update its test file in the same change.

## Git & Commits

- Only commit files changed in the current session. Stage explicit paths (`git add <path>...`), never `git add -A`.
- Commit message: `type: imperative summary` (`feat|fix|chore|docs|test`), body explains *why*.
- Version bumps are their own commit: `npm version patch|minor --no-git-tag-version`, then commit `package.json`+`package-lock.json` alone as `chore: bump version to X.Y.Z`.
  - patch: small additions/fixes; minor: new user-facing feature.
- Releasing: `git tag -a vX.Y.Z -m vX.Y.Z`, then `git push origin master && git push origin vX.Y.Z`. Tag push triggers the release workflow.

## Dependency Security

- Direct deps use caret ranges — treat `package.json`/`package-lock.json` diffs as reviewed code.
- Install with `npm install --ignore-scripts`.

## Architecture

- Single OpenAI-compatible provider via `PROVIDER_BASE_URL`/`PROVIDER_API_KEY`.
- Compaction: LLM-based summarization past a token threshold (falls back to pruning).
- Parallel tool execution: tool calls within one assistant message run concurrently via `Promise.all`.
- Reasoning: `vendors.ts` reads metadata from `/v1/models`, sends `reasoning.effort` param, parses `<think>` blocks.
- Skills and MCP servers: global path loads unconditionally, project path (`.cast/skills/`, `.cast/mcp.json`) is trust-gated.
- MCP: stdio and streamable-HTTP only; tool names namespaced `mcp_<server>_<tool>`.
- Pure CLI with `node:readline` — no TUI framework, no server, no orchestrator.
