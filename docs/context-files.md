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

The agent sees both files in its system prompt: `/org-guidelines/AGENTS.md` first (broad guidelines) followed by `my-app/AGENTS.md` (project-specific).

## Trust Model

- **Global** (`~/.cast/`) and **ancestor** files above `cwd`: loaded automatically without prompting.
- **Project** (`cwd`): trust-gated. cast asks once per project whether to trust local resources (skills, MCP, context files), saving the decision in `~/.cast/settings.json`.

## Nested Context Files

When reading or writing files in subdirectories, cast discovers `AGENTS.md`/`CLAUDE.md` files in those subdirectories. Nested context files activate when the agent touches files in their subtree.

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

Editing `apps/web/pages/index.tsx` attaches `apps/web/AGENTS.md`. Editing `apps/api/routes/users.ts` attaches `apps/api/AGENTS.md`.

Nested context files use shallow-to-deep ordering so narrow instructions take precedence over broad guidelines.

## Content Guidelines

Context files hold:
- Coding conventions and style guides
- Architecture decisions
- Build, test, and lint commands
- Deployment notes

Plain markdown with no custom syntax is expected.
