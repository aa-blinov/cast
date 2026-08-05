# Git Worktrees

`cast` supports running sessions inside isolated git worktrees. This allows the agent to inspect files, edit code, and run shell commands on a dedicated branch without modifying your main working directory or interfering with other active sessions.

## Overview

When worktree mode is enabled:
1. `cast` creates (or reuses) a git worktree at `.cast/worktrees/<name>` off the canonical git repository root.
2. A branch named `cast-<slug>` is checked out in that worktree directory (slashes in nested names like `feature/auth` are flattened to `+`, e.g. `cast-feature+auth`).
3. The session's working directory (`session.cwd`) switches to the worktree path. All built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`) operate inside the isolated worktree.
4. The worktree path is saved directly in the session database (`SessionState.cwd`), so resuming the session with `cast -c` or `cast --resume` automatically resumes execution inside the same worktree.

## Usage

### CLI

Pass `-w <name>` or `--worktree <name>` when launching `cast` or `cast run`:

```bash
# Launch interactive session in an isolated worktree named "fix-auth"
cast -w fix-auth

# Run a non-interactive task in a worktree
cast run -w feature-ui "refactor button components"
```

### Interactive TUI

Switch the active session into a worktree mid-conversation using the `/worktree` command:

```
/worktree fix-auth
```

If invoked inside an existing worktree (e.g. `/worktree nested`), `cast` anchors the new worktree at the main repo's `.cast/worktrees/` directory to prevent linked worktrees of worktrees.

### Web UI

When creating a new session from the Web UI control room, check **Run in an isolated git worktree** in the New Session modal. You can specify a custom worktree name or use the auto-generated `tree-XXXX` default.

## Cleanup

Worktrees and their branches are left on disk on exit so your work is never lost. To remove a completed worktree:

```bash
git worktree remove .cast/worktrees/<name>
git branch -D cast-<name>
```
