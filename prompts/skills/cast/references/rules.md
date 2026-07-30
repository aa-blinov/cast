Cursor-compatible rule files (not a single `rules.md`):

1. `~/.cast/rules/*.md` — global
2. `.cast/rules/*.md` — project (trust-gated)
3. Nested `.cast/rules/*.md` in subdirectories (up to 8 levels) — scoped to subtree

**Four apply modes** (from frontmatter):

| Mode | Frontmatter | Behavior |
|------|-------------|----------|
| always | `always-apply: true` | Injected every turn (globs ignored) |
| auto | `always-apply: false` + `globs` | Auto-attach when matching files enter context; sticky |
| lazy | `always-apply: false` + `description` | Model decides relevance, reads via read tool |
| manual | `always-apply: false` (no globs, no description) | Only via `@rule-name` or `/rule:<name>` |

**Commands:** `/rules` (list), `/rule:<name>` (force-load), `@rule-name` (mention in message).

**Example:**

```bash
mkdir -p .cast/rules
cat > .cast/rules/typescript.md << 'EOF'
---
always-apply: false
globs: ["*.ts", "*.tsx"]
---

Use strict TypeScript; prefer unknown over any.
EOF
```

Then `/reload`.
