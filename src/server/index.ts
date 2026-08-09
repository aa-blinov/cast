/**
 * Web server entry point. Exported so src/index.ts can call it directly in
 * foreground mode (no child-process spawn needed). The standalone `main()`
 * at the bottom is only used when this file runs as a child process (daemon).
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { closeMcpConnections } from "../core/mcp.ts";
import { resolveMcpForCwd } from "../core/project.ts";
import { loadSettings, updateSettings } from "../core/settings.ts";
import type { ParsedArgs } from "../core/startup.ts";
import { runStartup } from "../core/startup.ts";
import type { Pickers, PickOption } from "../pickers/types.ts";
import { createServerBridge } from "./bridge.ts";
import { clearServerState, DAEMON_PROTOCOL_VERSION, writeServerState } from "./daemon-state.ts";
import { startServer } from "./server.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const VERSION: string = process.env.CAST_VERSION ?? "0.0.0";

export async function runServerMain(args: string[], options: { foreground: boolean; version?: string }): Promise<void> {
	const ver = options.version ?? VERSION;
	// Parse --port / --host
	let port = parseInt(process.env.CAST_SERVER_PORT ?? "1337", 10);
	let host = process.env.CAST_SERVER_HOST ?? "127.0.0.1";
	// Set by the CLI launcher (src/index.ts), not passed as a CLI arg — the
	// launcher already strips --foreground out of the args it forwards, since
	// that flag only controls *how it spawns*, not anything the server itself
	// does — except which lifecycle it reports in the state file.
	const foreground = options.foreground;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1]!, 10);
			i++;
		} else if (args[i] === "--host" && args[i + 1]) {
			host = args[i + 1]!;
			i++;
		} else if (args[i] === "--public") {
			host = "0.0.0.0";
		}
	}

	const settings = loadSettings();
	const cwd = process.env.CAST_CWD ? (await import("node:path")).resolve(process.env.CAST_CWD) : homedir();

	// Non-interactive pickers for web mode
	const webPickers: Pickers = {
		pickOption: async <T>(options: PickOption<T>[]): Promise<T | null> => {
			// Auto-select first non-muted option
			const first = options.find((o) => !o.muted);
			return first?.value ?? options[0]?.value ?? null;
		},
		promptText: async (_label: string, defaultValue?: string): Promise<string | null> => defaultValue ?? null,
		pickMulti: async <T>(options: PickOption<T>[]): Promise<T[] | null> => options.map((o) => o.value),
		log: (text: string) => console.log(text),
	};

	// Parse CLI model/persona/reasoning
	let cliModel: string | undefined;
	let cliPersona: string | undefined;
	let cliReasoning: string | undefined;
	let cliBypassPermissions = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		}
	}

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested: false,
		resumePicker: false,
		cliBypassPermissions,
		noSkills: false,
		cliSkillPaths: [],
		noMcp: false,
		cliMcpPaths: [],
		version: ver,
		// Real MCP connections (npx package resolution, browser launches for
		// something like @playwright/mcp, remote-server handshakes) can take
		// far longer than everything else runStartup does combined — there's
		// no reason the HTTP server should sit unreachable for that whole
		// window. Connect for real in the background, after listen(), instead.
		deferMcp: true,
	};

	// Auth: ensure password exists in settings
	const currentSettings = loadSettings();
	let serverPassword = currentSettings.serverToken ?? currentSettings.webPassword;
	if (!serverPassword) {
		serverPassword = randomBytes(18).toString("base64url");
		updateSettings({ serverToken: serverPassword });
		console.log("[cast server] first run — password generated and saved to ~/.cast/settings.json");
	}

	console.log("[cast server] starting up...");

	// Deliberately NOT writing the state file here, before the server actually
	// binds — daemon-state.ts's whole contract is that the file only exists
	// once a server is truly listening, which is what lets readLiveServerState
	// answer "already running" correctly and lets a status/health check that
	// sees the file trust it can actually connect. Writing early (as this once
	// did, to dodge the launcher's old fixed timeout) reintroduces exactly the
	// race that contract exists to prevent: up to runStartup's full duration
	// (MCP setup, model probe — can be 10+ seconds) where the file claims a
	// server is running that isn't accepting connections yet. See
	// waitForStartup in index.ts for the other half of this fix — its timeout
	// is generous enough to tolerate that same delay instead of needing this
	// early write as a workaround.
	const result = await runStartup(parsedArgs, webPickers);
	console.log(`[cast server] persona: ${result.persona.label}, model: ${result.session.model}`);
	console.log("[cast server] ────────────────────────────────────");
	console.log(`[cast server]   login:    cast`);
	console.log(`[cast server]   password: ${serverPassword}`);
	console.log("[cast server] ────────────────────────────────────");

	const bridge = createServerBridge(result);

	if (!LOOPBACK_HOSTS.has(host)) {
		console.log(
			`[cast server] ⚠ binding ${host} — reachable from other machines on this network, protected only by the password above.`,
		);
	}

	// Local-only token for TUI clients on loopback — lets `cast` (the TUI)
	// talk to the daemon over HTTP+SSE without the browser's interactive
	// login. The browser still logs in with cast_web_session; this is a
	// separate, file-only credential the TUI reads from web.json. Skipped
	// for non-loopback binds (a remote daemon must be treated like any
	// other client and auth through the normal login flow).
	const localToken = LOOPBACK_HOSTS.has(host) ? randomBytes(24).toString("base64url") : undefined;

	// Set before the server is even created so the background MCP connect
	// below (which can finish after a shutdown was already requested) has
	// something to check — declared here, read (never reassigned) by that
	// connect's .then(), and set true by the shutdown handler further down.
	let shuttingDown = false;

	const server = startServer({
		port,
		host,
		bridge,
		webUser: "cast",
		serverPassword,
		version: ver,
		onListening: (boundPort: number) => {
			// Write the state file now that we have the real bound port (may differ
			// from `port` when 0 was passed for OS assignment). The TUI reads this
			// for both the port and the loopback token.
			writeServerState({
				protocolVersion: DAEMON_PROTOCOL_VERSION,
				pid: process.pid,
				port: boundPort,
				host,
				startedAt: new Date().toISOString(),
				foreground,
				...(localToken ? { token: localToken } : {}),
			});
			console.log(`[cast server] stop: cast server stop`);
			// The deferred half of ParsedArgs.deferMcp above: now that the HTTP
			// server is actually accepting connections, do the real connect
			// (npx resolution, browser launches, remote handshakes — whatever
			// was skipped to get here fast) and swap it in once it's done.
			// Every run reads bridge's MCP result fresh at turn-start (the same
			// mechanism /mcp enable/disable already relies on), so the very
			// next message in any open session picks up the newly connected
			// tools automatically — no restart needed.
			const mcpConnectStart = Date.now();
			resolveMcpForCwd(
				result.projectDeps,
				result.cwd,
				result.projectTrusted,
				loadSettings().disabledMcpServers ?? [],
			)
				.then((mcpResult) => {
					if (shuttingDown) {
						// Nothing applied these connections anywhere — close them
						// rather than leaking a subprocess/browser past shutdown.
						closeMcpConnections(mcpResult.connections);
						return;
					}
					bridge.applyMcpResult(mcpResult);
					console.log(`[cast server] MCP servers connected in background (${Date.now() - mcpConnectStart}ms)`);
				})
				.catch((err) => {
					console.error(
						"[cast server] background MCP connect failed:",
						err instanceof Error ? err.message : String(err),
					);
				});
		},
		onError: (err) => {
			if (err.code === "EADDRINUSE") {
				console.error(`[cast server] port ${port} is already in use on ${host}.`);
				console.error(
					`[cast server] run 'cast server status' to check what's running, or pick a different port with --port.`,
				);
			} else {
				console.error("[cast server] failed to start:", err.message);
			}
			process.exit(1);
		},
	});

	// Graceful shutdown — closing every live session drains their background
	// bash tasks and marks in-flight runs aborted before the process actually
	// exits, instead of Node's default "just die" behavior on SIGTERM/SIGINT.
	// SIGKILL (a hard `kill -9`, an OOM kill) can't be caught by anything —
	// that's exactly why start/stop/status all treat a dead recorded PID as
	// stale and self-heal, rather than assuming this handler always runs.
	// (shuttingDown itself is declared above, before onListening — the
	// background MCP connect's .then() needs to read it too.)
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[cast server] received ${signal}, shutting down...`);
		for (const s of bridge.listSessions()) bridge.closeSession(s.id, "shutdown");
		clearServerState();
		server.close(() => process.exit(0));
		// server.close() waits for existing connections (including open SSE
		// streams) to end on their own — force exit if that takes too long
		// rather than hanging a `cast server stop` caller indefinitely.
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
	await runServerMain(process.argv.slice(2), { foreground: process.env.CAST_SERVER_FOREGROUND === "1" });
}

// Auto-run only when this file is the entry point (daemon spawn). The parent
// sets CAST_SERVER_SKIP_AUTORUN=1 before importing for inline foreground mode.
if (!process.env.CAST_SERVER_SKIP_AUTORUN) {
	main().catch((err) => {
		console.error("[cast server] fatal:", err);
		clearServerState();
		process.exit(1);
	});
}
