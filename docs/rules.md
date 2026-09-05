# Rules

Rules are project-specific instructions the agent follows. They use Cursor's rule format, so a project that already has Cursor rules needs no second copy of them.

cast reads, in this order:

- `~/.cast/rules/` — your global rules
- `<project>/.cast/rules/` — project rules (trust-gated)
- `<project>/.cursor/rules/` — a Cursor project's own rules, read as-is
- the same directories nested in subdirectories, scoped to that subtree

Both `.md` and Cursor's `.mdc` are read, and subfolders inside a rules
directory are for organisation — a rule keeps the scope of the rules directory
it lives under, however it is filed.

## Rule Types

There are four apply modes, matching Cursor's rule anatomy:

### Always Apply

```markdown
---
always-apply: true
---

Follow these conventions in every response.
```

Injected into the system prompt every turn. The `globs` field is ignored.

### Auto Attach

```markdown
---
always-apply: false
globs: ["**/*.ts", "**/*.tsx"]
---

Use strict TypeScript with no `any` types.
```

Automatically injected when matching files enter the agent's context (via read/write/edit). Once activated, the rule stays for the rest of the session ("sticky").

### Agent Requested (Lazy)

```markdown
---
always-apply: false
description: Use when writing database migrations
---

Always create reversible migrations with both up and down.
```

The agent sees the rule's name and description in its system prompt. It reads the full content via the `read` tool when the task seems relevant.

### Manual

```markdown
---
always-apply: false
---

Special instructions for edge cases.
```

Only activated by `@rule-name` mention in a message or `/rule:<name>` command.

## Rule Placement

| Location | Scope | Trust |
|----------|-------|-------|
| `~/.cast/rules/` | Global (all projects) | Always loaded |
| `.cast/rules/` | Project root | Trust-gated |
| `.cursor/rules/` | Project root (a Cursor project's own rules) | Trust-gated |
| `apps/web/.cast/rules/` | Nested subtree | Trust-gated |

### Nested Rules

Rules can live in `.cast/rules/` directories at any depth in the project tree (up to 8 levels). A nested rule at `apps/web/.cast/rules/style.md` has scope `apps/web` — its always/auto injection only fires once a context file under `apps/web/` is seen.

This matches Cursor's nested rules feature: rules are dormant until the agent touches files in their subtree.

## File Format

```markdown
---
name: api-style
always-apply: false
globs: ["src/api/**/*.ts"]
description: API endpoint conventions
---

## API Endpoints

- Always return typed responses
- Use zod for input validation
- Handle errors with the shared error middleware
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `name` | Human label (defaults to the filename without its extension) |
| `always-apply` | `true` for always mode; `false` + globs/description for other modes |
| `globs` | Glob patterns for auto attach mode — a YAML array, or one comma-separated string (`globs: *.ts, *.tsx`) |
| `description` | Description for agent-requested (lazy) mode |

### Glob syntax

Patterns are matched against the file's path relative to the project root, the
same way Cursor and minimatch read them:

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `*.ts` | `main.ts` | `src/main.ts` |
| `**/*.ts` | `main.ts`, `src/deep/main.ts` | `main.js` |
| `src/*.ts` | `src/main.ts` | `src/deep/main.ts` |
| `src/**/*.ts` | `src/main.ts`, `src/deep/main.ts` | `lib/main.ts` |
| `docs/**` | everything under `docs/` | `other/x.md` |
| `*.{ts,tsx}` | `main.ts`, `main.tsx` | `main.js` |

`*` and `?` never cross a `/`; only `**` does. To match a file type anywhere in
the project, write `**/*.ts` rather than `*.ts`.

A rule in a nested `.cast/rules` directory writes its globs relative to its own
subtree: `apps/web/.cast/rules/style.md` with `globs: src/**/*.ts` matches
`apps/web/src/a.ts`.

The apply mode is determined automatically from the frontmatter:
- `always-apply: true` → **always**
- `always-apply: false` + `globs` → **auto**
- `always-apply: false` + `description` (no globs) → **lazy**
- `always-apply: false` (no globs, no description) → **manual**

## @-Mentions

Reference a rule in your message by typing `@rule-name`:

```
@api-style review this endpoint
```

This activates the rule for that turn, regardless of its apply mode. Matching is by the bare `name` (case-insensitive). Code fences are skipped — `@name` inside a code block doesn't trigger.

## Commands

| Command | Description |
|---------|-------------|
| `/rules` | List all loaded rules with their apply mode, globs, scope, and source |
| `/rule:<name>` | Invoke a rule by name (loads full content into context) |

The `/rules` output shows each rule's state:

```
Rules
  api-style [auto:globs] globs=["src/api/**/*.ts"] (project) — API endpoint conventions
  security [always] (global) — Security review checklist
  migration [lazy] (project) — Database migration conventions
  edge-cases [manual] (project) — Special edge case handling
```

Auto rules show `[auto:sticky]` once they've been activated for the session, or `[auto:globs]` if they haven't matched yet.

## Priority

On a name collision (same `id`), the first-loaded rule wins:

1. **Project** (`.cast/rules/`, then `.cursor/rules/`) — highest priority
2. **Global** (`~/.cast/rules/`)

Within one scope, project beats global and the first-loaded file wins.
