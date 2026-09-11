#!/usr/bin/env bash
# Idempotently point git at .githooks/ for this checkout. Runs from
# package.json's `prepare` script on `npm install` / `npm ci`, and is
# safe to call by hand: if core.hooksPath is already set (to anything,
# including this same path) it's left alone.
set -euo pipefail

repoRoot="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repoRoot" ] || [ "$repoRoot" != "$(pwd)" ]; then
	# Not at the repo root — skip silently. CI steps that aren't in the
	# repo root (worktrees, subdir invocations) shouldn't touch config.
	exit 0
fi

current="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ -n "$current" ] && [ "$current" != ".githooks" ]; then
	echo "[hooks] core.hooksPath is already '$current' — leaving it alone."
	echo "[hooks] (run scripts/install-hooks.sh --force if you want to override)"
	exit 0
fi

git config --local core.hooksPath .githooks
echo "[hooks] core.hooksPath set to .githooks/"
