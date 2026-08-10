import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcpAgent } from "./core/acp/agent.ts";
import { printHelp } from "./core/help.ts";
import { runInteractive, runNonInteractive } from "./core/run.ts";
import { loadSettings } from "./core/settings.ts";
import type { ParsedArgs } from "./core/startup.ts";
import { runUpgrade } from "./core/upgrade.ts";
import {
	acquireStartLock,
	clearServerState,
	DAEMON_STARTUP_TIMEOUT_MS,
	DaemonProtocolMismatchError,
	isCurrentDaemonInstance,
	isDaemonProtocolCompatible,
	isProcessAlive,
	readLiveServerState,
	readServerState,
	releaseStartLock,
} from "./server/daemon-state.ts";
import { runTui } from "./ui/tui.tsx";

const VERSION: string = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
).version;

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args[0] === "upgrade") {
		const rest = args.slice(1);
		const force = rest.includes("--force");
		// A mistyped flag (e.g. `--forse`) isn't `--force`, so the old
		// `rest.find((a) => a !== "--force")` picked it up as the *pinned
		// version* instead — silently attempting to upgrade to a "version"
		// literally named "--forse" instead of erroring on the bad flag.
		const unknownFlags = rest.filter((a) => a.startsWith("--") && a !== "--force");
		if (unknownFlags.length > 0) {
			console.error(`Unknown option(s) for 'cast upgrade': ${unknownFlags.join(", ")}`);
			console.error("Usage: cast upgrade [version] [--force]");
			process.exit(1);
		}
		const pinnedVersion = rest.find((a) => a !== "--force");
		await runUpgrade(VERSION, pinnedVersion, force);
		return;
	}

	if (args[0] === "run") {
		await handleRunCommand(args.slice(1), VERSION);
		return;
	}

	if (args[0] === "web" || args[0] === "server") {
		await handleServerCommand(args.slice(1));
		return;
	}

	if (args[0] === "acp") {
		await handleAcpCommand(args.slice(1), VERSION);
		return;
	}

	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let initialPrompt: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let resumePicker = false;
	let cliBypassPermissions = false;
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];
	let worktree: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--resume") {
			resumeRequested = true;
			resumePicker = true;
		} else if (args[i]?.startsWith("--resume=")) {
			resumeRequested = true;
			resumeId = args[i]!.slice("--resume=".length);
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--worktree" || args[i] === "-w") {
			// Optional value: the next arg is the name if it doesn't look
			// like a flag. Matches the convention used by `claude -w foo`
			// and `cast run` subcommand. If omitted, runStartup will throw
			// a useful error explaining the name is required.
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				worktree = next;
				i++;
			} else {
				console.error("--worktree requires a name: cast --worktree <name>");
				process.exit(2);
			}
		} else if (args[i]?.startsWith("--worktree=")) {
			worktree = args[i]!.slice("--worktree=".length);
		} else if (args[i] === "--help" || args[i] === "-h") {
			printHelp();
			return;
		} else if (args[i] === "--version" || args[i] === "-v") {
			console.log(`cast v${VERSION}`);
			return;
		} else {
			initialPrompt = args.slice(i).join(" ");
			break;
		}
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt,
		resumeRequested,
		resumeId,
		resumePicker,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		worktree,
		version: VERSION,
	};

	await runTui(parsedArgs, await ensureDaemon());
}

/**
 * Ensures a `cast server` daemon is running so the TUI can be a thin client of
 * it (single-writer daemon model: the daemon owns runAgentLoop and streams
 * events over SSE to every surface). If a live daemon already exists, reuse
 * it; otherwise spawn one and wait for it to become reachable. On anything
 * other than a clean start (already running, spawn failed, or --no-daemon),
 * returns undefined so the caller can fall back to running locally.
 *
 * Trust-localhost: the daemon writes a loopback-only token into web.json, which
 * the TUI reads to skip the browser's interactive login.
 */
async function ensureDaemon(): Promise<string | undefined> {
	if (process.env.CAST_NO_DAEMON === "1") return undefined;
	try {
		const tokenFor = async (state: ReturnType<typeof readLiveServerState>): Promise<string | undefined> => {
			if (!state) return undefined;
			if (!isDaemonProtocolCompatible(state)) throw new DaemonProtocolMismatchError(state);
			if (!(await isCurrentDaemonInstance(state))) {
				clearServerState();
				return undefined;
			}
			return state.token;
		};
		// Concurrent `cast` launches (two terminals opened back-to-back) both
		// see an empty state file before the first daemon records itself, so a
		// bare "empty → spawn" race stacks two daemons. Serialize the spawn
		// with an exclusive lock: only the lock holder runs `server start`,
		// everyone else waits (bounded) for it to record state and then reuses
		// the winner instead of spawning a second process.
		const waitForDaemon = async (attempt: number): Promise<string | undefined> => {
			if (attempt >= 100) return undefined;
			const existing = readLiveServerState();
			if (existing) {
				const token = await tokenFor(existing);
				if (token) return token;
			}
			if (!acquireStartLock()) {
				await new Promise((r) => setTimeout(r, 100));
				return waitForDaemon(attempt + 1);
			}
			try {
				// Re-check under the lock: the winner may have recorded state
				// while we waited for the lock.
				const now = readLiveServerState();
				if (now) {
					const token = await tokenFor(now);
					if (token) return token;
				}
				await handleServerCommand(["start", "--port", "0"]);
				return tokenFor(readLiveServerState());
			} finally {
				releaseStartLock();
			}
		};
		return await waitForDaemon(0);
	} catch (error) {
		if (error instanceof DaemonProtocolMismatchError) throw error;
		return undefined;
	}
}

async function handleRunCommand(args: string[], version: string): Promise<void> {
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let cliBypassPermissions = false;
	let format: "default" | "json" = "default";
	let interactive = false;
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];
	let worktree: string | undefined;
	const messageParts: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--format") {
			const f = args[i + 1];
			if (f === "json") format = "json";
			i++;
		} else if (args[i] === "--interactive") {
			interactive = true;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--worktree" || args[i] === "-w") {
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				worktree = next;
				i++;
			} else {
				console.error('--worktree requires a name: cast run --worktree <name> "..."');
				process.exit(2);
			}
		} else if (args[i]?.startsWith("--worktree=")) {
			worktree = args[i]!.slice("--worktree=".length);
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`Usage: cast run [options] <message>
       cast run --interactive [options]

Options:
  -c, --continue         Continue the most recent session
  -s, --session <id>     Continue a specific session by ID
  -m, --model <model>    Model to use (provider/model)
  -r, --reasoning <lvl>  Reasoning level
  -p, --persona <name>   Persona to use
  -w, --worktree <name>  Run in an isolated git worktree (cast/.cast/worktrees/<name>)
  --format <default|json>  Output format
  --interactive          Persistent JSONL session protocol on stdin/stdout
  --bypass-permissions   Skip destructive-action confirmations (bash + write)`);
			return;
		} else {
			messageParts.push(...args.slice(i));
			break;
		}
	}

	const message = messageParts.join(" ").trim();
	if (!interactive && !message) {
		console.error("Usage: cast run [options] <message>");
		console.error("Run 'cast run --help' for options.");
		process.exit(1);
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested,
		resumeId,
		resumePicker: false,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		worktree,
		version,
	};

	if (interactive) {
		await runInteractive(parsedArgs);
		return;
	}
	await runNonInteractive(parsedArgs, { message, format });
}

async function handleAcpCommand(args: string[], version: string): Promise<void> {
	let cwd: string | undefined;
	let sessionId: string | undefined;
	let resume = false;
	let bypass = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--cwd") {
			const value = args[i + 1];
			if (!value || value.startsWith("-")) {
				console.error("Usage: cast acp [--cwd <path>] [--session <id>] [--continue] [--bypass-permissions]");
				process.exit(2);
			}
			cwd = value;
			i++;
		} else if (a === "--session" || a === "-s") {
			const value = args[i + 1];
			if (!value || value.startsWith("-")) {
				console.error("Usage: cast acp [--cwd <path>] [--session <id>] [--continue] [--bypass-permissions]");
				process.exit(2);
			}
			sessionId = value;
			i++;
		} else if (a === "--continue" || a === "-c") {
			resume = true;
		} else if (a === "--bypass-permissions") {
			bypass = true;
		} else if (a === "--help" || a === "-h") {
			console.log(`Usage: cast acp [options]

Options:
  --cwd <path>        Project root for the new session
  --session <id>      Resume a specific session by id
  --continue          Resume the most recent session in --cwd
  --bypass-permissions  Auto-approve destructive actions (bash + write/edit/patch)
  --help              Show this help

cast speaks the Agent Client Protocol (JSON-RPC 2.0 over stdio) using
@agentclientprotocol/sdk. Connect any ACP client (e.g. zed, JetBrains,
Neovim) to wire it as an agent.`);
			return;
		} else {
			console.error(`Unknown option for 'cast acp': ${a}`);
			console.error("Usage: cast acp [--cwd <path>] [--session <id>] [--continue] [--bypass-permissions]");
			process.exit(2);
		}
	}

	const { runStartup } = await import("./core/startup.ts");
	const { loadSettings } = await import("./core/settings.ts");
	const settings = loadSettings();
	const resolvedCwd = cwd ? resolve(cwd) : (process.env.CAST_CWD ?? process.cwd());

	// ACP has no UI surface for pickers — push a no-op set so startup
	// doesn't block on interactive prompts.
	const noopPickers = {
		pickOption: async <T>() => null as T | null,
		promptText: async () => null,
		pickMulti: async <T>() => [] as T[],
		log: (() => {}) as never,
	};

	const startup = await runStartup(
		{
			cwd: resolvedCwd,
			settings,
			resumeRequested: resume,
			resumeId: sessionId,
			resumePicker: false,
			cliBypassPermissions: bypass,
			noSkills: false,
			cliSkillPaths: [],
			noMcp: false,
			cliMcpPaths: [],
			version,
		},
		noopPickers as {
			pickOption: typeof noopPickers.pickOption;
			promptText: typeof noopPickers.promptText;
			pickMulti: typeof noopPickers.pickMulti;
			log: typeof noopPickers.log;
		},
	);

	const permissionMode = bypass ? "bypass" : (startup.permissionMode as "default");
	runAcpAgent(startup, { version, permissionMode, sessionId, resume });
}

async function handleServerCommand(args: string[]): Promise<void> {
	const LOG_FILE = join(homedir(), ".cast", "server.log");

	if (args[0] === "stop") {
		await stopServerDaemon();
		return;
	}

	if (args[0] === "status") {
		printServerStatus();
		return;
	}

	// Anything else non-flag-shaped falls through to "start the server"
	// below by default — so a typo of "stop"/"status" (e.g. "stpo", "statu")
	// used to silently start a new daemon instead of erroring, which is the
	// opposite of what stopping/checking status was trying to do.
	if (args[0] && args[0] !== "start" && !args[0].startsWith("-")) {
		console.error(`[cast server] unknown subcommand "${args[0]}"`);
		console.error(
			"Usage: cast server [start] [--port <n>] [--host <addr>] [--public] [--foreground] | cast server stop | cast server status",
		);
		process.exit(1);
	}

	const foreground = args.includes("--foreground");
	const port = getPort(args);
	const host = getHost(args);

	// Everything except lifecycle flags (subcommand, port/host/public,
	// foreground) forwards to the server process as-is — model/persona/
	// reasoning/bypass-permissions. Port and host are re-appended explicitly
	// below so the child always gets one canonical `--port`/`--host`
	// regardless of how the user spelled them (e.g. `--public` alone).
	const restArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "start" || a === "--foreground" || a === "--public") continue;
		if (a === "--port" || a === "--host") {
			i++; // also skip this flag's value
			continue;
		}
		restArgs.push(a);
	}

	const existing = readLiveServerState();
	if (existing) {
		const mode = existing.foreground ? " (foreground)" : "";
		console.error(
			`[cast server] already running (pid ${existing.pid})${mode} — http://${existing.host}:${existing.port}`,
		);
		console.error("[cast server] use 'cast server stop' first, or 'cast server status' to check.");
		process.exit(1);
	}

	// Dev mode (tsx + .ts source) vs release mode (bundled dist/index.js).
	// import.meta.url is <repo>/src/index.ts in dev, <install>/dist/index.js in release.
	const selfPath = fileURLToPath(import.meta.url);
	const isRelease = selfPath.includes("/dist/");
	const spawnCwd = join(dirname(selfPath), "..");
	const spawnArgs = isRelease
		? [join(spawnCwd, "dist", "index.js"), "server", ...restArgs, "--port", String(port), "--host", host]
		: ["--import", "tsx", "./src/server/index.ts", ...restArgs, "--port", String(port), "--host", host];
	const spawnEnv = {
		...process.env,
		CAST_CWD: homedir(),
		CAST_SERVER_PORT: String(port),
		CAST_SERVER_HOST: host,
		CAST_SERVER_FOREGROUND: foreground ? "1" : "0",
		CAST_VERSION: VERSION,
	};

	// Foreground: run inline. Daemon: spawn child. Daemon child: run inline.
	// CAST_SERVER_FOREGROUND distinguishes daemon-child from the launcher:
	// "0" = I am the daemon child, run inline (set by spawnEnv below).
	// "1" = user asked --foreground, run inline (set by the CLI flag).
	// unset = I am the launcher, spawn a child.
	if (foreground || process.env.CAST_SERVER_FOREGROUND === "0") {
		process.env.CAST_SERVER_SKIP_AUTORUN = "1";
		const { runServerMain } = await import("./server/index.ts");
		runServerMain(args, { foreground, version: VERSION });
		return;
	}

	// Daemon mode: spawn detached, then wait for the child to actually report
	// success (its own state-file write, only made once really listening —
	// see web/index.ts) or failure (it exits early — bad port, crash, a
	// runStartup error) instead of declaring victory the instant spawn()
	// returns, which is true whether or not the child goes on to bind at all.
	const logFd = openSync(LOG_FILE, "a");
	const child = spawn(process.execPath, spawnArgs, {
		cwd: spawnCwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: spawnEnv,
	});
	child.unref();

	const started = await waitForStartup(child.pid!);
	if (!started) {
		console.error(`[cast server] failed to start — see ${LOG_FILE} for details`);
		process.exit(1);
	}
	console.log(`[cast server] started (pid ${child.pid}) — http://${host}:${port}`);
	const settingsForMessage = loadSettings();
	const activeProvider = settingsForMessage.providers?.find(
		(provider) => provider.name === settingsForMessage.modelProvider,
	);
	const hasProvider = Boolean(
		(activeProvider?.url && activeProvider.apiKey) || (settingsForMessage.providerUrl && settingsForMessage.apiKey),
	);
	if (!hasProvider) {
		console.log("[cast server] no provider configured yet");
		console.log("[cast server] configure one in the web UI, or run 'cast' again for terminal onboarding");
	}
	console.log(`[cast server] logs: ${LOG_FILE}`);
	console.log(`[cast server] stop: cast server stop`);
}

/**
 * Polls for the child's own state-file write (real success, only made once
 * it's actually listening) or its early exit (real failure) — up to 60s, not
 * 5s: the child's own startup runs `runStartup` first (MCP server setup,
 * model probe), which the code that write the state file explicitly notes
 * can take 10+ seconds on its own before the HTTP server ever binds. A
 * shorter timeout here previously forced the state file to be written before
 * that finished just so this wouldn't time out on a slow-but-successful
 * startup — which broke the file's own contract (see daemon-state.ts) that
 * its existence means a server is truly bound. A genuinely broken startup
 * (bad port, crash) is still caught quickly regardless of this timeout,
 * since the process-death check below fires as soon as the child actually
 * exits — this number only matters for how long a legitimately slow but
 * still-succeeding startup gets before being called a failure.
 */
function waitForStartup(pid: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			resolvePromise(ok);
		};
		const poll = setInterval(() => {
			const state = readServerState();
			if (state?.pid === pid) finish(true);
			else if (!isProcessAlive(pid)) finish(false);
		}, 150);
		setTimeout(() => finish(false), DAEMON_STARTUP_TIMEOUT_MS).unref();
	});
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const start = Date.now();
		const poll = setInterval(() => {
			if (!isProcessAlive(pid)) {
				clearInterval(poll);
				resolvePromise(true);
			} else if (Date.now() - start >= timeoutMs) {
				clearInterval(poll);
				resolvePromise(false);
			}
		}, 100);
	});
}

async function stopServerDaemon(): Promise<void> {
	const state = readServerState();
	if (!state) {
		console.log("[cast server] not running");
		return;
	}
	if (!isProcessAlive(state.pid)) {
		// Killed out from under us — by the OS, an OOM killer, or the user
		// directly. Nothing to signal; just say so honestly and clean up
		// instead of claiming to have "stopped" a process that was already gone.
		console.log(`[cast server] was not actually running (pid ${state.pid} is gone) — stale state cleaned up`);
		clearServerState();
		return;
	}
	if (!(await isCurrentDaemonInstance(state))) {
		console.log("[cast server] state does not identify the daemon at its recorded address; refusing to signal PID");
		clearServerState();
		return;
	}

	process.kill(state.pid, "SIGTERM");
	let died = await waitForExit(state.pid, 3000);
	if (!died) {
		// The in-process SIGTERM handler didn't finish in time (slow session
		// drain, or an old build without the handler at all) — escalate
		// rather than leave the caller thinking `stop` silently did nothing.
		try {
			process.kill(state.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
		died = await waitForExit(state.pid, 1000);
	}
	clearServerState();
	console.log(`[cast server] stopped (pid ${state.pid}) — was on http://${state.host}:${state.port}`);
	if (!died) console.log("[cast server] warning: process may not have fully exited");
}

function printServerStatus(): void {
	const state = readServerState();
	if (!state) {
		console.log("[cast server] not running");
		return;
	}
	if (!isProcessAlive(state.pid)) {
		console.log("[cast server] stale state — process not running");
		clearServerState();
		return;
	}
	const mode = state.foreground ? " (foreground)" : "";
	console.log(`[cast server] running (pid ${state.pid})${mode} — http://${state.host}:${state.port}`);
	console.log(`[cast server] started: ${state.startedAt}`);
}

function getPort(args: string[]): number {
	const idx = args.indexOf("--port");
	if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1]!, 10);
	return parseInt(process.env.CAST_SERVER_PORT ?? "1337", 10);
}

function getHost(args: string[]): string {
	const idx = args.indexOf("--host");
	if (idx >= 0 && args[idx + 1]) return args[idx + 1]!;
	if (args.includes("--public")) return "0.0.0.0";
	return process.env.CAST_SERVER_HOST ?? "127.0.0.1";
}

main().catch((err) => {
	if (err instanceof DaemonProtocolMismatchError) {
		console.error(err.message);
		process.exit(1);
	}
	console.error(err);
	process.exit(1);
});
