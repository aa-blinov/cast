Skills are reusable instruction files the model can read on demand.

**Locations** (highest priority first — on name collision, first-loaded wins):

1. `.cast/skills/` — project (trust-gated)
2. `.agents/skills/` — skills.sh universal project path (trust-gated)
3. `~/.cast/skills/` — global
4. `~/.config/agents/skills/` / `~/.agents/skills/` — skills.sh universal global
5. Shipped with cast — builtin
6. `--skill <directory>` — explicit skill package directory (still loads with `--no-skills`)

`--no-skills` skips project, agents, global, and builtin discovery.

`npx skills add owner/repo --skill name -a universal` → `.agents/skills/`; invoke with `/skill:name`.

**File format** — a directory with `SKILL.md`:

```
.cast/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: What this skill does. Shown to the model in the available skills list.
disable-model-invocation: true
---

# My Skill

Instructions the model reads when this skill is invoked...

(Relative paths inside the skill directory resolve against it.)
```

**Rules:**

- `name` must be lowercase, alphanumeric + hyphens
- `name` must match the directory containing `SKILL.md`
- `description` is required (shown to the model)
- Optional standard fields: `license`, `compatibility` (up to 500 characters), `metadata` (string-to-string map), `allowed-tools` (experimental)
- `disable-model-invocation: true` — skill is hidden from model, only usable via `/skill:name`
- `/skills` — multi-select toggle; also `list`, `enable`/`disable <name>`, `uninstall`, `help`
- `/skills uninstall` — delete a cast/agents skill from disk (picker or name + confirm); builtin and `--skill` paths are not removable
- On name collision: `.cast` project > `.agents` project > `.cast` global > `.agents` global > builtin

**Example — create a skill:**

```bash
mkdir -p ~/.cast/skills/git-workflow
cat > ~/.cast/skills/git-workflow/SKILL.md << 'EOF'
---
name: git-workflow
description: Branch naming, commit messages, and PR conventions for this repo.
---

# Git Workflow

- Branch naming: `feat/<ticket>-<short-desc>`, `fix/<ticket>-<short-desc>`
- Commit format: `<type>(<scope>): <summary>`
- Always squash-merge PRs
EOF
```

## skills.sh

`/skills-sh search <query>`, `/skills-sh list-available <owner/repo>`,
`/skills-sh install <owner/repo> --skill <name>`, `/skills-sh uninstall <name>` —
same in the TUI and the web UI (Settings → Skills.sh). Installs go to the
universal scope (`~/.agents/skills`) and the catalog refreshes in the same
session. A pasted `npx skills add …` line or a github.com URL is accepted; an
`-a <agent>` flag is dropped because that form installs only into one agent's
directory, which cast does not scan.
