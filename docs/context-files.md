# Context Files

cast automatically discovers and loads `AGENTS.md` or `CLAUDE.md` files from your project tree and injects them into the system prompt. This gives the agent project-specific instructions without needing to create a skill or rule.

## How It Works

cast searches for these filenames (case-insensitive):

- `AGENTS.md` / `AGENTS.MD`
- `CLAUDE.md` / `CLAUDE.MD`

### Discovery Walk

1. **Global**: `~/.cast/AGENTS.md` (or `CLAUDE.md`) — loaded first, always trusted
2. **Ancestor walk**: cast walks from `cwd` to the filesystem root (`/`), loading a context file from each directory. Files are returned root-first so broad organizational guidelines precede project-specific ones.
3. **cwd**: The file in the current directory is trust-gated — it loads only if the project is trusted.

### Example

Given this structure:

```
/org-guidelines/AGENTS.md          # "Use TypeScript strict mode"
/org-guidelines/frontend/           # no context file
/org-guidelines/frontend/my-app/    # cwd
  AGENTS.md                         # "This project uses React 19"
```

The agent sees both files in its system prompt, with `/org-guidelines/AGENTS.md` first (broad guidelines) and `my-app/AGENTS.md` second (project-specific).

## Trust Model

- **Global** (`~/.cast/`) and **ancestor** files (above `cwd`): always loaded — you placed those yourself
- **Project** (`cwd`): trust-gated. cast asks once per project whether to trust its local resources (skills, MCP, context files). The decision is saved in `~/.cast/settings.json`.

## Nested Context Files

When the agent reads or writes files in subdirectories, cast discovers `AGENTS.md`/`CLAUDE.md` files in those subdirectories too. These "nested" context files activate when the agent touches files in their subtree.

Example:

```
my-app/
  AGENTS.md                    # "General project conventions"
  apps/
    web/
      AGENTS.md                # "This app uses Next.js App Router"
    api/
      AGENTS.md                # "This service uses Express + Prisma"
```

If the agent edits `apps/web/pages/index.tsx`, it also sees `apps/web/AGENTS.md`. If it later edits `apps/api/routes/users.ts`, it sees `apps/api/AGENTS.md`.

Nested context files are ordered shallow-to-deep (broad → specific), so the nearest-to-the-file instructions read last.

## What to Put in Context Files

- Coding conventions and style guides
- Architecture decisions
- Build/test/lint commands
- Deployment notes
- Anything the agent should know about the project

No special syntax — just markdown. The agent reads it as part of its instructions.
