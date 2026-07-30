Skills are reusable instruction files the model can read on demand.

**Locations** (highest priority first — on name collision, first-loaded wins):

1. `.cast/skills/` — project (trust-gated)
2. `.agents/skills/` — skills.sh universal project path (trust-gated)
3. `~/.cast/skills/` — global
4. `~/.config/agents/skills/` / `~/.agents/skills/` — skills.sh universal global
5. Enabled marketplace plugins (`/plugin install`) — `source: plugin`
6. Shipped with cast — builtin
7. `--skill <path>` — extra CLI paths (still load with `--no-skills`)

`--no-skills` skips project, agents, global, plugin, and builtin discovery.

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
- `description` is required (shown to the model)
- `disable-model-invocation: true` — skill is hidden from model, only usable via `/skill:name`
- `/skills` — multi-select toggle; also `list`, `enable`/`disable <name>`, `uninstall`, `help`
- `/skills uninstall` — delete cast/agents skill from disk (picker or name + confirm); plugin skills show locked → `/plugin uninstall`
- Plugin skills are labeled `plugin · name@marketplace`; if the pack is off, they stay visible but locked until `/plugin` re-enables the pack
- On name collision: `.cast` project > `.agents` project > `.cast` global > `.agents` global > plugin > builtin

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
