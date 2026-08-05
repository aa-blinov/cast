# Git Worktrees

`cast` supports running sessions inside isolated git worktrees. This allows the agent to inspect files, edit code, and run shell commands on a dedicated branch without modifying your main working directory or interfering with other active sessions.

## Mechanics

Worktree mode creates or reuses a git worktree at `.cast/worktrees/<name>` off the canonical repository root. A branch named `cast-<slug>` is checked out in that directory, flattening slashes in nested names like `feature/auth` to `cast-feature+auth`.

The session working directory (`session.cwd`) switches to the worktree path so tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`) execute within the isolated directory. The path persists in SQLite session state (`SessionState.cwd`), ensuring resumes automatically maintain worktree isolation.

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
