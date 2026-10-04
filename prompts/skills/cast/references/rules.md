Cursor-compatible rule files (not a single `rules.md`). Both `.md` and Cursor's
`.mdc` are read, as are subfolders inside a rules directory (organisation only —
the rule keeps its directory's scope):

1. `~/.cast/rules/` — global
2. `<project>/.cast/rules/` — project
3. `<project>/.cursor/rules/` — an existing Cursor project's rules, read as-is
4. The same directories nested in subdirectories (up to 8 levels) — scoped to that subtree

Everything but the global folder is trust-gated: the trust question lists every rules folder found (nested and `.cursor/rules` included, and the project root's when the session starts in a subfolder). The nested search skips `node_modules`, `dist`, `build`, `target`, `.next`, `vendor`, dot folders and the like, and stops at 4,000 directories.

**Four apply modes** (from frontmatter):

| Mode | Frontmatter | Behavior |
|------|-------------|----------|
| always | `always-apply: true` (Cursor's `alwaysApply` too; `yes`/`on`/`1` and a quoted `"true"` count) | Injected every turn (globs ignored) |
| auto | `always-apply: false` + `globs` | Auto-attach when matching files enter context; sticky |
| lazy | `always-apply: false` + `description` | Model decides relevance, reads via read tool |
| manual | `always-apply: false` (no globs, no description) | Only via `@rule-name` or `/rule:<name>` |

**Commands:** `/rules` (list), `/rule:<name>` (force-load; a nested rule is `/rule:apps/web/style`, its id as `/rules` prints it), `@rule-name` (mention in message; letters, digits, `-`, `_`, inner dots; a name with spaces cannot be mentioned but `/rule:` runs it). `@` and a matching glob latch a rule for the rest of the session, and the latch is saved with the session.

## Glob syntax

Matched against the file's path relative to the project root — the same reading
Cursor and minimatch use. `*` and `?` never cross a `/`; only `**` does.

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `*.ts` | `main.ts` | `src/main.ts` |
| `**/*.ts` | `main.ts`, `src/deep/main.ts` | `main.js` |
| `src/*.ts` | `src/main.ts` | `src/deep/main.ts` |
| `src/**/*.ts` | `src/main.ts`, `src/deep/main.ts` | `lib/main.ts` |
| `docs/**` | everything under `docs/` | `other/x.md` |
| `*.{ts,tsx}` | `main.ts`, `main.tsx` | `main.js` |

To cover a file type across the project write `**/*.ts`, not `*.ts` — the
second one only matches the repository root. This is the most common mistake
when writing a rule that "never fires".

`globs` accepts a YAML array (`["**/*.ts", "docs/**"]`), one pattern
(`globs: **/*.ts`), or Cursor's comma-separated string (`globs: *.ts, *.tsx`).
A comma inside braces stays part of the pattern.

## Nested rules

A rule in `apps/web/.cast/rules/` is dormant until a file under `apps/web/`
enters context (`/rules` shows an always-apply one as `[always:waiting]`), or
from the first message when the session works in `apps/web` itself or below it.
Its globs are written relative to that subtree. A subagent's prompt, built with
no turn behind it, carries the project's own always-apply rules and those around
its working folder:

```markdown
---
always-apply: false
globs: src/**/*.ts
---

Web app conventions.
```

placed at `apps/web/.cast/rules/style.md` attaches on `apps/web/src/a.ts`.

## Writing a rule

```bash
mkdir -p .cast/rules
cat > .cast/rules/typescript.md << 'EOF'
---
always-apply: false
globs: ["**/*.ts", "**/*.tsx"]
---

Use strict TypeScript; prefer unknown over any.
EOF
```

Then `/reload`.

Choosing the mode:

- **always** — a short standing instruction that applies to the whole project.
  It is re-sent on *every* request, so keep it brief; bodies over 64KB are
  truncated with a note saying so.
- **auto** — conventions tied to a file type or area. Preferred over `always`
  for anything language- or directory-specific.
- **lazy** — needs a `description`; the model reads the file when the
  description sounds relevant. Good for long reference material.
- **manual** — invoked deliberately with `/rule:<name>` or `@name`.

## Checking your work

`/rules` lists every loaded rule with its mode, globs, scope, and source —
`[auto:globs]` means it has not matched yet this session, `[auto:sticky]` that
it has latched (`[manual:sticky]` / `[lazy:sticky]` for one an `@` mention latched), `[always:waiting]` that a nested always-apply rule is waiting
for a file of its subtree, `[on disk, not loaded: /reload]` that the file is
new. The same text shows in the terminal and the web UI. After the rules it
lists any rule file cast could not load (unreadable, wrong permissions) with
the reason, and notes: a rule hidden by another of the same name (the first
loaded wins: `.cast` over `.cursor`, `.md` over `.mdc`, project over global),
an `always-apply` value that was not understood, a name `@` cannot spell.

A rule that shows up as `manual` when you meant `auto` means the `globs` field
did not parse; one that is `manual` when you meant `always` has an
`always-apply` value `/rules` names in its notes. A rule missing entirely means
the file is outside a discovered rules directory (or under a skipped folder
such as `build/`), or the project is untrusted.

Limits: 64KB per rule, 160KB for all the always-apply and latched ones together
(the rest are named, not silently dropped), and a budget of about 3k tokens for
the lazy list (descriptions are cut evenly, names and paths stay).
