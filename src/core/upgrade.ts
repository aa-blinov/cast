/**
 * Self-upgrade: checking for a newer release and re-running the same
 * installer (install.sh/install.ps1, published via GitHub Pages — see
 * .github/workflows/pages.yml) rather than duplicating its download/extract
 * logic here. One source of truth for "how to install cast."
 */

import { spawnSync } from "node:child_process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clearServerState,
	isCurrentDaemonInstance,
	isProcessAlive,
	readServerState,
	type ServerDaemonState,
} from "../server/daemon-state.ts";

const V_PREFIX_RE = /^v/;

const REPO = process.env.CAST_REPO ?? "aa-blinov/cast";
const PAGES_BASE = process.env.CAST_PAGES_BASE ?? "https://aa-blinov.github.io/cast";
// Matches install.sh/install.ps1's CAST_API_BASE override — same
// purpose: pointing this at a local server for testing.
const API_BASE = process.env.CAST_API_BASE ?? "https://api.github.com";

/**
 * True when running the built release bundle (dist/index.js), false for the
 * dev path (src/index.ts via tsx, e.g. `npm link`). Distinguishes because
 * "upgrade" only makes sense for the former — the latter is a git checkout,
 * updated with `git pull`.
 *
 * Confirmed safe on macOS: a running process keeps executing fine even after
 * the file/directory it was loaded from is deleted and replaced (the OS
 * keeps the old inode alive until the process exits) — so re-running the
 * installer while `cast upgrade` is itself running from dist/index.js
 * doesn't crash mid-upgrade. Not verified on Windows, where open files are
 * typically locked against replacement — see the win32 branch in
 * runUpgrade(), which prints instructions instead of attempting it live.
 */
export function isReleaseInstall(): boolean {
	return fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
}

/** Strips a leading "v" — GitHub tags are "v0.2.0", package.json says "0.2.0". */
function normalizeVersion(v: string): string {
	return v.replace(V_PREFIX_RE, "");
}

/**
 * Numeric dot-separated comparison. No pre-release/build metadata to worry
 * about — this project just ships plain x.y.z tags — so a full semver
 * library would be more machinery than the actual scheme needs.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
	const a = normalizeVersion(current).split(".").map(Number);
	const b = normalizeVersion(candidate).split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (bv > av) return true;
		if (bv < av) return false;
	}
	return false;
}

/** Latest published release's version (no "v" prefix), or null on any failure. */
export async function fetchLatestVersion(): Promise<string | null> {
	try {
		const res = await fetch(`${API_BASE}/repos/${REPO}/releases/latest`);
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? normalizeVersion(data.tag_name) : null;
	} catch {
		return null;
	}
}

/**
 * True when the reinstall would be a no-op: same version, not forced.
 * `targetVersion` is null when it couldn't be determined (fetchLatestVersion
 * failed) — in that case we don't know it's a no-op, so don't skip; let the
 * installer run and surface its own, more informative network error.
 */
export function isAlreadyUpToDate(currentVersion: string, targetVersion: string | null, force: boolean): boolean {
	if (force || !targetVersion) return false;
	return normalizeVersion(currentVersion) === normalizeVersion(targetVersion);
}

/**
 * `cast upgrade` / `cast upgrade <version>` / `... --force`. Re-runs
 * the public installer in-process via the platform shell — same script real
 * users run, so this can't drift from what actually works.
 *
 * Returns (with `process.exitCode` set on failure) instead of calling
 * `process.exit()`: a hard exit right after the fetch in fetchLatestVersion
 * races libuv's handle teardown on Windows and crashes with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (async.c) after
 * the useful output was already printed. Nothing on this path holds the
 * event loop open, so a natural return exits immediately anyway.
 */
export async function runUpgrade(currentVersion: string, pinnedVersion?: string, force = false): Promise<void> {
	if (!isReleaseInstall()) {
		console.log("cast is running from source (dev mode), not an installed release — nothing to upgrade here.");
		console.log("Update the checkout instead: git pull");
		return;
	}

	// A pinned version is the target as-is; otherwise ask what's latest.
	const targetVersion = pinnedVersion ? normalizeVersion(pinnedVersion) : await fetchLatestVersion();
	if (isAlreadyUpToDate(currentVersion, targetVersion, force)) {
		console.log(`Already up to date (v${currentVersion}).`);
		console.log('Use "cast upgrade --force" to reinstall anyway.');
		return;
	}

	const env: NodeJS.ProcessEnv = { ...process.env };
	if (pinnedVersion) env.CAST_VERSION = pinnedVersion;

	console.log(pinnedVersion ? `Upgrading to v${pinnedVersion}...\n` : "Upgrading to the latest release...\n");

	if (process.platform === "win32") {
		// Windows locks files that are in use — the installer would try to
		// remove/replace the very directory this running process was loaded
		// from. Print the command instead of risking a half-done upgrade;
		// the file lock releases once this process exits.
		console.log("Run this in a new terminal (can't self-replace a running process's files on Windows):\n");
		console.log(
			pinnedVersion
				? `  $env:CAST_VERSION="${pinnedVersion}"; irm ${PAGES_BASE}/install.ps1 | iex`
				: `  irm ${PAGES_BASE}/install.ps1 | iex`,
		);
		return;
	}

	const result = spawnSync("bash", ["-c", `curl -fsSL ${PAGES_BASE}/install | bash`], {
		stdio: "inherit",
		env,
	});

	if (result.status !== 0) {
		console.error("\nUpgrade failed — see output above.");
		process.exitCode = 1;
		return;
	}

	if (!(await restartDaemon())) process.exitCode = 1;
}

/**
 * `cast server` daemon still executes the bundle it was started from, so after a
 * reinstall the running daemon would keep serving the old code until manually
 * restarted. If a daemon is live, stop it and start a fresh one on the
 * freshly-installed build (via the `cast` launcher on PATH, which now points
 * at the new install). No-op when no daemon is running — the upgrade must not
 * start one that wasn't there.
 */
/** @internal exported for unit tests */
export async function restartDaemon(): Promise<boolean> {
	const state = readServerState();
	if (!state || !isProcessAlive(state.pid)) return true;
	if (!(await isCurrentDaemonInstance(state))) {
		console.log("[cast server] could not verify the running daemon after upgrade; leaving its PID untouched.");
		clearServerState();
		return false;
	}
	if (state.foreground) {
		console.log(
			"[cast server] foreground daemon left running after upgrade; restart it manually to preserve its terminal ownership.",
		);
		return true;
	}
	console.log(`\n[cast server] daemon was running (pid ${state.pid}) — restarting it on the new build...`);
	try {
		process.kill(state.pid, "SIGTERM");
	} catch {
		// already gone
	}
	if (!(await waitForDaemonExit(state))) {
		console.log(
			"[cast server] daemon did not stop cleanly; leaving restart to the user to avoid interrupting active work.",
		);
		return false;
	}
	clearServerState();
	const started = spawnSync("cast", ["server", "start", "--port", String(state.port), "--host", state.host], {
		stdio: "inherit",
	});
	if (started.status !== 0) {
		console.log("[cast server] note: the new daemon failed to start — run 'cast server start' manually.");
		return false;
	}
	const restarted = readServerState();
	if (
		!restarted ||
		restarted.pid === state.pid ||
		!isProcessAlive(restarted.pid) ||
		!(await isCurrentDaemonInstance(restarted))
	) {
		console.log("[cast server] upgrade completed, but the new daemon could not be verified.");
		return false;
	}
	console.log(`[cast server] running (pid ${restarted.pid}) — http://${restarted.host}:${restarted.port}`);
	return true;
}

async function waitForDaemonExit(state: ServerDaemonState): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + 10_000;
		const check = () => {
			if (!isProcessAlive(state.pid)) return resolve(true);
			if (Date.now() >= deadline) return resolve(false);
			setTimeout(check, 100);
		};
		check();
	});
}
