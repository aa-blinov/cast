/**
 * Self-upgrade: checking for a newer release and re-running the same
 * installer (install.sh/install.ps1, published via GitHub Pages — see
 * .github/workflows/pages.yml) rather than duplicating its download/extract
 * logic here. One source of truth for "how to install cast."
 */

import { spawn, spawnSync } from "node:child_process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { API_V1_PREFIX } from "../server/api-v1.ts";
import { rememberedBind } from "../server/daemon-bind.ts";
import {
	clearServerState,
	daemonBaseUrl,
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
export async function restartDaemon(options: { turnWaitMs?: number; turnPollMs?: number } = {}): Promise<boolean> {
	const state = readServerState();
	if (!state || !isProcessAlive(state.pid)) return true;
	if (!(await isCurrentDaemonInstance(state))) {
		console.log("[cast server] could not verify the running daemon after upgrade; leaving its PID untouched.");
		clearServerState();
		return false;
	}
	// The daemon can also be the process running this: `POST /api/system/upgrade`
	// calls runUpgrade *inside* the daemon (that is how the web UI's Upgrade
	// button works). SIGTERM below would then be suicide — the shutdown handler
	// closes every session and exits within a few seconds, so the spawnSync that
	// was supposed to start the replacement never ran, and the button left the
	// user with a freshly installed cast and no daemon at all (verified: the log
	// ends at "received SIGTERM", server.json is gone, nothing is listening).
	// Hand the restart to a detached waiter that starts the new daemon once this
	// pid is gone, then shut down normally so sessions still drain.
	if (state.pid === process.pid) {
		console.log(`\n[cast server] restarting this daemon (pid ${state.pid}) on the new build...`);
		spawn(
			"sh",
			[
				"-c",
				`while kill -0 ${state.pid} 2>/dev/null; do sleep 0.2; done; exec cast server start ${startArgs(state).join(" ")}`,
			],
			{ detached: true, stdio: "ignore" },
		).unref();
		process.kill(state.pid, "SIGTERM");
		return true;
	}
	if (state.foreground) {
		console.log(
			"[cast server] foreground daemon left running after upgrade; restart it manually to preserve its terminal ownership.",
		);
		return true;
	}
	// The daemon ends every turn it is running when it stops, and the terminal screen shows that as an
	// interrupted request that is not resumed. Give turns time to finish before stopping it.
	const pollMs = options.turnPollMs ?? 1000;
	const deadline = Date.now() + (options.turnWaitMs ?? TURN_WAIT_MS);
	let busy = await runningTurns(state);
	if (busy > 0) {
		console.log(
			`\n[cast server] ${busy === 1 ? "a turn is" : `${busy} turns are`} running; waiting for ${busy === 1 ? "it" : "them"} to finish before restarting the daemon...`,
		);
	}
	while (busy > 0 && Date.now() < deadline) {
		// biome-ignore lint/performance/noAwaitInLoops: polls until the running turns are over
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		busy = await runningTurns(state);
	}
	if (busy > 0) {
		console.log(
			"[cast server] still busy: the daemon stays on the old build so that nothing is interrupted. Restart it when the turn is over: 'cast server stop && cast server start'.",
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
	const started = spawnSync("cast", ["server", "start", ...startArgs(state)], { stdio: "inherit" });
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

/**
 * Where the daemon comes back: the address the person last chose, else where it was. An upgrade is not a
 * choice, so it does not remember anything (a daemon that had fallen back to a private port must not
 * replace the public address that is remembered).
 */
function startArgs(state: ServerDaemonState): string[] {
	const bind = rememberedBind() ?? { host: state.host, port: state.port };
	return ["--port", String(bind.port), "--host", bind.host, "--no-remember"];
}

/** How long an upgrade waits for running turns before it leaves the daemon on the old build. */
const TURN_WAIT_MS = 120_000;

/** How many sessions the daemon is running a turn in right now; 0 when it cannot be asked. */
async function runningTurns(state: ServerDaemonState): Promise<number> {
	if (!state.token) return 0;
	try {
		const response = await fetch(`${daemonBaseUrl(state)}${API_V1_PREFIX}/sessions`, {
			headers: { Authorization: `Bearer ${state.token}` },
			signal: AbortSignal.timeout(4_000),
		});
		if (!response.ok) return 0;
		const body = (await response.json()) as Array<{ status?: string }> | { sessions?: Array<{ status?: string }> };
		const sessions = Array.isArray(body) ? body : (body.sessions ?? []);
		return sessions.filter((session) => session.status === "running").length;
	} catch {
		return 0;
	}
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
