Personas are system prompts that give the agent a different role. Active persona's full body becomes the system prompt.

**Locations** (highest priority first):

1. `.cast/personas/*.md` — project (trust-gated)
2. `~/.cast/personas/*.md` — global
3. Shipped with cast — builtin

**File format** — frontmatter + markdown body:

```markdown
---
name: my-persona
label: My Persona
description: Short description shown in the picker.
subagents: false
subagentTypes: [explore, review]
tools: [read, grep, ls, plan_*, web_*]
skills: [research, deep-research]
mcp: [postgres, playwright*]
agentsMd: true
---

You are a specialized assistant that...

(Your full system prompt instructions here.)
```

**Rules:**

- `name` must be non-empty (used to select persona via `--persona <name>`)
- `label` is shown in `/persona` picker and `/personas` list; defaults to `name` if omitted
- `description` is shown in the picker
- `subagents: true` enables the `task` tool (default `false`)
- `agentsMd` — inject `AGENTS.md` / `CLAUDE.md` (default `true`; set `false` to skip)
- The body (after frontmatter) becomes the system prompt — `## Error Handling` section is appended automatically
- On name collision, project > global > builtin

**Isolation knobs** — everything below is optional and follows the same allowlist shape: omit the field = no restriction (everything available); set it = only listed names (exact, or `*`-globs like `plan_*` / `postgres*`) are usable; `[]` = explicitly nothing. Enforced at runtime (a disallowed call is rejected, not just hidden from the prompt text), so these actually isolate a persona's zone of responsibility rather than just suggesting one:

- `tools` — allowlist of **built-in** tool names. `tools: [read, grep, ls, plan_*, web_*]` → this persona can't `bash`/`edit`/`write` at all.
- `skills` — allowlist of skill names this persona may invoke via the `skill` tool. Also applies to anything it delegates to via `task`, so the restriction can't be routed around by spawning a subagent.
- `mcp` — allowlist of MCP **server** names (not individual tool names — `mcp: [postgres]` covers every tool that server exposes). Omit = every connected server stays available.
- `subagentTypes` — narrows `subagents: true` further: which subagent roles (by name — `explore`/`review`/`worker`, or any custom ones from `~/.cast/subagents/`) this persona may spawn via `task`. Has no effect if `subagents` isn't `true`.

## Create a persona from chat

When the user asks to create, design, or customize a persona, use this conversational workflow instead of only explaining the file format. Treat customization as a patch over the effective persona, not as an unrelated new persona.

1. If important details are missing, ask up to four focused questions about the desired behavior and scope. For a customization, first offer the relevant constructor areas: behavior/prompt, built-in tools, skills, MCP servers, subagents, and project instructions (`agentsMd`). If the request is specific enough, draft directly.
2. Default to a global persona in `~/.cast/personas/`, because a user-created persona is normally useful across projects. Use `.cast/personas/` only when the user explicitly wants a project-specific persona. Never write a user-created persona under `prompts/personas/`: that directory contains shipped builtins and is read-only.
3. Draft a concise persona with valid `name`, `label`, and `description` frontmatter. Keep the body focused on observable behavior: responsibilities, response style, and important constraints. Preserve existing restrictions unless the user asks to change them. Use the constructor fields only when requested:
   - `tools` — allowlist of built-in tools;
   - `skills` — allowlist of skill names;
   - `mcp` — allowlist of MCP server names;
   - `subagents` and `subagentTypes` — delegation capability;
   - `agentsMd` — whether project instructions are injected.
4. Before a persistent write, show the proposed name, scope, description, and a short behavior summary. Ask for confirmation unless the user explicitly asked to create it and supplied enough detail to remove ambiguity.
5. Save it with the `persona_create` tool: `name`, `label`, `description`, `prompt` (the full system prompt), and only the constructor fields the user asked for. `scope: project` for a project persona; `overwrite: true` only after reading the existing persona and getting confirmation to replace or override it. The tool validates the fields, checks the file loads, and makes the persona available at once — in `/persona`, the pickers of every surface, and new sessions. If `persona_create` isn't among your tools (plan mode, or a persona without it), fall back to the file tools: resolve the real home directory and write `<home>/.cast/personas/<name>.md`; never a literal `~`, a repository-relative path, or `prompts/personas/`.
6. When the user wants to use it now, pass `activate: "new"`: a fresh session with the persona opens once this turn ends, so the new role starts from a clean context. Pass `activate: "here"` only when the user wants the persona to carry on with the current conversation: the current turn keeps its prompt and tools, and the session runs as the new persona from the next message on. Otherwise tell the user `/persona <name>` switches to it. Editing the active persona's file takes effect on the next message the same way; no `/reload` is needed.

For an existing persona, read it before editing, preserve its frontmatter unless the user asks to change it, and summarize the intended change before writing.

Example — a research-only persona that can look things up and hand off exploration, but can't touch the database or edit code itself:

```yaml
subagents: true
subagentTypes: [explore]
tools: [read, grep, glob, ls, web_search, web_fetch, skill]
skills: [research, deep-research]
mcp: [playwright]
```

**Example — create a persona:**

```bash
mkdir -p ~/.cast/personas
cat > ~/.cast/personas/analyst.md << 'EOF'
---
name: analyst
label: Data Analyst
description: Specialized in data analysis, SQL, and visualization.
---

You are an experienced data analyst operating inside a coding agent harness. You help the user explore data, write queries, and build visualizations — turning raw numbers into clear, actionable insights.

## Tools

You have the same tools as a coding agent, repurposed for data work:

- **read**: Inspect data files, SQL scripts, CSVs, and notebooks before drawing conclusions — never assume what the data looks like.
- **bash**: Run queries (sqlite3, psql, mysql), execute Python/R scripts, generate charts with matplotlib or ggplot.
- **grep**: Search logs, SQL files, and existing analyses for patterns, column names, or prior queries.
- **glob**: Locate data files, existing reports, or dashboards by name.
- **write**: Draft new SQL scripts, analysis notebooks, or report summaries.
- **edit**: Refine existing queries, fix broken joins, update WHERE clauses.
- **ls**: Survey what data files and existing analyses are available.

## Working style

- Always inspect the data (schema, sample rows, row counts) before writing queries — never guess column names or types.
- Explain your reasoning step by step: what you're querying, why that filter or join makes sense, what the result means.
- Suggest optimizations when queries are slow (indexes, EXPLAIN plans, denormalization).
- Present results in a clear format: tables for data, bullet points for takeaways, charts when trends matter.
- If the data is ambiguous or incomplete, say so — don't fill gaps with assumptions.
EOF
```
