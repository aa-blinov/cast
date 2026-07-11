# Architecture

An overview of cast's source layout and key design decisions. For contributors and the curious.

## Source Layout

```
src/
  core/               Agent logic (no UI dependency)
    loop.ts           Agent loop — streaming, tool dispatch, compaction
    tools.ts          17 tool definitions + executors
    tools/
      bash.ts         Shell execution
      files.ts        Read/write/edit
      search.ts       Find/grep/ls
      web.ts          web_search (DuckDuckGo), web_fetch (Jina Reader)
      task.ts         Sub-agent delegation
      shared.ts       Shared types (ToolResult, ConfirmBash)
    llm.ts            LLM interaction, streaming, retry, prompt caching
    session.ts        Session persistence, token estimation, compaction
    mcp.ts            MCP server connection (stdio + streamable HTTP)
    personas.ts       Persona loading (project > global > builtin)
    rules.ts          Cursor-compatible rule system (always/auto/lazy/manual)
    skills.ts         Agent Skills spec implementation
    config.ts         AppConfig, model validation, onboarding
    context-files.ts  AGENTS.md / CLAUDE.md discovery
    project.ts        System prompt assembly, trust gating
    startup.ts        Unified startup orchestration
    runner.ts         Queue management (steering, follow-ups)
    run.ts            Non-interactive runner (cast run)
    vendors.ts        Reasoning metadata, think-block parsing
    upgrade.ts        Self-update via GitHub releases
    permissions.ts    Dangerous bash command detection
    plan.ts           Plan mode state, file I/O, read-only bash gate
    frontmatter.ts    Minimal YAML frontmatter parser
    prompts.ts        Prompt file loading
    readline.ts       Readline utilities, models cache
    settings.ts       User settings persistence
    subagents.ts      Sub-agent prompt loading
    ...
  ui/                 Ink TUI components
    App.tsx           Top-level layout
    Composer.tsx      Input with autocomplete, image paste
    ChatLog.tsx       Message rendering
    commands.ts       Slash command handlers
    themes/           Color theme registry and definitions
    input/            Keybindings, input handling
    ...
  pickers/            Onboarding pickers (model, persona, reasoning)
  index.ts            CLI entry point
```

## Key Design Decisions

### Single OpenAI-Compatible Provider

cast speaks one API: the OpenAI chat completions format. Any provider that implements this API works — OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, Azure OpenAI. No provider-specific code paths.

### Parallel Tool Execution

Tool calls within one assistant message run concurrently via `Promise.all`. If the model requests `bash`, `read`, and `grep` in a single response, all three execute simultaneously.

### Context Compaction

When the conversation exceeds ~75% of the context window, older messages are summarized by the LLM. The split is ~60/40 (old/recent), snapped to turn boundaries so tool calls and results stay together. File paths are extracted deterministically from tool calls and appended to the summary.

### MCP Integration

MCP tools are namespaced as `mcp_<server>_<tool>` and converted to the same `Tool`/`ToolResult` shapes the built-in tools use. The rest of the codebase doesn't need to know MCP tools are different.

### Trust Gating

A single trust decision per project gates all local resources (skills, MCP, context files, personas). Global resources (`~/.cast/`) always load. Asked once, remembered in settings.json.

### Plan Mode

Plan mode is a restricted agent state: read-only bash, read tool, plan tools. The read-only bash gate uses a curated allowlist of inspection binaries. Plan files persist as markdown with checkbox tracking.

## Development

```bash
npm install --ignore-scripts
npm start               # Run from source (tsx)
npm run check           # Type check + lint (tsc + biome)
npm test                # Unit tests (vitest)
npm run build           # Bundle into dist/index.js (esbuild)
npm run format          # Auto-format (biome)
```

### Testing

- Framework: vitest
- One `test/<module>.test.ts` per `src/<module>.ts`
- No real LLM/API calls — mock configs with fake `baseURL`/`apiKey`
- MCP tests are the exception: they spawn a real local test-fixture server
- Tool tests use `test/__test_tmp__/`, created in `beforeEach`, removed in `afterEach`

### Build

The bundle step (esbuild) produces a single `dist/index.js` file — self-contained, no `node_modules` needed at runtime.
