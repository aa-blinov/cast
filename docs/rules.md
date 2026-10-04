# Rules

Rules are project-specific instructions the agent follows. They use Cursor's rule format, so a project that already has Cursor rules needs no second copy of them.

Rules are resolved from the **project root**: the nearest ancestor with a
`.git` (or, failing that, the topmost one with a `.cast/`). A session started
in a subdirectory therefore sees the same rules as one started at the root:
`cd apps/web && cast` gets the repository's rules, not none. The home
directory is never a root, so `~/.cast` stays global configuration.

cast reads, in this order:

- `~/.cast/rules/`: your global rules
- `<project>/.cast/rules/`: project rules (trust-gated)
- `<project>/.cursor/rules/`: a Cursor project's own rules, read as-is
- the same directories nested in subdirectories, scoped to that subtree

**Trust.** Everything except `~/.cast/rules/` is written into the system prompt, so it is behind the project trust question: the first time you open a project that has any rule file, cast lists every rules folder it found (`.cast/rules/`, `.cursor/rules/`, nested `apps/web/.cast/rules/`, and the project root's when you started in a subfolder) and asks. A rules folder with no rule file in it does not trigger the question. Until you say yes (or when you say no), only your global rules load.

Both `.md` and Cursor's `.mdc` are read, and subfolders inside a rules
directory are for organisation: a rule keeps the scope of the rules directory
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

Rules can live in `.cast/rules/` directories at any depth in the project tree (up to 8 levels). A nested rule at `apps/web/.cast/rules/style.md` has scope `apps/web`. Its always/auto injection only fires once a context file under `apps/web/` is seen, or from the first message when the session itself works in `apps/web` (or below it): a session started in `apps/web` has the rules of `apps/web` and of every folder above it, none from `apps/api`.

This matches Cursor's nested rules feature: rules are dormant until the agent touches files in their subtree. A prompt built with no turn behind it (a subagent's, for one) therefore carries the project's own always-apply rules and those around its working folder, not the nested ones elsewhere. Subagents do not get auto-attached rules: they never have a file of theirs in context before they start.

The search for nested folders skips `node_modules`, `.git`, `.cast`, `dist`, `build`, `out`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `vendor`, `.venv`, `venv`, `__pycache__` and `target`, every folder starting with a dot, and stops after 4,000 directories: a rules folder under one of those is not found. A subfolder inside a rules folder is for organisation only (four levels deep).

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
| `always-apply` (or Cursor's `alwaysApply`) | `true` for always mode; `false` + globs/description for other modes. `true`, `yes`, `on`, `1` count as true, in any case, quoted or not; a value that is none of these is reported in `/rules` and read as false |
| `globs` | Glob patterns for auto attach mode: a YAML array, or one comma-separated string (`globs: *.ts, *.tsx`) |
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

This activates the rule for the rest of the session, regardless of its apply mode, the same way an auto rule stays attached once its glob matched. Matching is by the bare `name` (case-insensitive). Code fences are skipped: `@name` inside a code block doesn't trigger.

A name can use letters, digits, `-`, `_` and inner dots (`@api.style`; a dot that ends a sentence is not part of it). A name with spaces (`Spaces In Name.md`) cannot be mentioned; `/rules` says so, and `/rule:Spaces In Name` still runs it.

**Latched rules survive a restart.** The rules a session has latched, by a file or by `@`, are saved with the session. Open it again (resume, a restarted daemon) and they are in force from the first message, as the conversation expects. Always-apply rules need no saving. A rule file that is gone is dropped.

## Commands

| Command | Description |
|---------|-------------|
| `/rules` | List all loaded rules with their apply mode, globs, scope, and source, then what did not load and notes |
| `/rule:<name>` | Invoke a rule by name (loads full content into context). A nested rule is `/rule:apps/web/style`, its `id` as `/rules` prints it; the bare name works too |

The `/rules` output shows each rule's state, the same text in the terminal and the web UI:

```
Rules
  api-style [auto:globs] globs=["src/api/**/*.ts"] (project) — API endpoint conventions
  security [always] (global) — Security review checklist
  migration [lazy] (project) — Database migration conventions
  edge-cases [manual] (project) — Special edge case handling
  apps/web/web-rules [always:waiting] scope=apps/web (project) — Web app conventions
```

Auto rules show `[auto:sticky]` once they've been activated for the session, or `[auto:globs]` if they haven't matched yet; a lazy or manual rule that an `@` mention latched shows `[manual:sticky]` or `[lazy:sticky]`. A nested always-apply rule shows `[always:waiting]` until a file of its subtree is in context. A rule file you added since the last `/reload` is listed as `[on disk, not loaded: /reload]`.

A rule file cast could not read (wrong permissions, a broken symlink) is listed after the rules with the reason. One bad file never stops the others from loading, but it is not dropped in silence either.

**Notes** follow, for rules that did load: one hidden by another of the same name (`dup.md` over `dup.mdc` in one folder, a project rule over a global one: the first loaded wins), a `always-apply` value that was not understood, and a name `@` cannot spell.

## Limits

Always-apply and latched rules are paid for on every request, so they are bounded: each rule is cut at 64,000 characters, and all of them together at 160,000; a rule that does not fit is named in a note at the end of the block, so it is neither read in part nor missing in silence. The list of lazy rules (name, description, path) has a budget of about 3,000 tokens: past it each description is cut to an even share (never under 80 characters, marked with `…`), and the names and paths always stay.

## Priority

On a name collision (same `id`), the first-loaded rule wins:

1. **Project** (`.cast/rules/`, then `.cursor/rules/`), highest priority
2. **Global** (`~/.cast/rules/`)

Within one scope, project beats global and the first-loaded file wins.
