/**
 * HTTP/SSE client for the `cast server` daemon — the shared access path for
 * every non-browser surface (the TUI via useAgentSession, headless `cast run`,
 * and later the JSONL runner). Wraps the REST endpoints the server exposes
 * (src/server/server.ts) and the WebEvent stream the bridge broadcasts.
 *
 * The daemon is spawned/attached the same way for everyone: reuse a live one
 * via the state file, else spawn a detached child (see ensureDaemon below).
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Node 22 has no global EventSource; undici ships one (experimental) that we
// use to receive the daemon's SSE stream. The browser build (esbuild bundle)
// provides a real global EventSource, so this import is Node-only and safe in
// both runtimes.
import { EventSource } from "undici";
import { readLiveServerState, type ServerDaemonState } from "./daemon-state.ts";

export interface ServerClient {
	baseUrl: string;
	token?: string;
}

/**
 * Returns the running daemon's base URL + loopback token, starting one if
 * nothing is alive. Mirrors index.ts's ensureDaemon so headless surfaces
 * (cast run) attach to the same single persistent daemon the TUI uses.
 * Honors CAST_NO_DAEMON=1 by returning undefined (callers then fall back to
 * running locally, e.g. the JSONL runner during a transition).
 */
export async function ensureServerClient(): Promise<ServerClient | undefined> {
	if (process.env.CAST_NO_DAEMON === "1") return undefined;
	const existing = readLiveServerState();
	if (existing) return { baseUrl: `http://${existing.host}:${existing.port}`, token: existing.token };
	try {
		const state = await spawnDetachedDaemon();
		if (!state) return undefined;
		return { baseUrl: `http://${state.host}:${state.port}`, token: state.token };
	} catch {
		return undefined;
	}
}

/**
 * Spawns a detached daemon (dev: tsx src/server/index.ts; release: dist
 * bundle) and waits for it to report a real bound port in the state file.
 * Mirrors index.ts's spawn: this module is inlined into dist/index.js by
 * esbuild, so import.meta.url resolves to the CLI entry in both modes.
 */
async function spawnDetachedDaemon(): Promise<ServerDaemonState | undefined> {
	const logFile = join(homedir(), ".cast", "server.log");
	const selfPath = fileURLToPath(import.meta.url);
	const isRelease = selfPath.includes("/dist/");
	// index.ts: spawnCwd = dirname(cli entry) + ".."; dev spawns the tsx
	// source, release spawns dist/index.js server start.
	const spawnCwd = join(dirname(selfPath), "..");
	const args = isRelease
		? [join(spawnCwd, "dist", "index.js"), "server", "start", "--port", "0"]
		: ["--import", "tsx", "./src/server/index.ts", "--port", "0", "--host", "127.0.0.1"];
	const { openSync } = await import("node:fs");
	const logFd = openSync(logFile, "a");
	const child = spawn(process.execPath, args, {
		cwd: spawnCwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: {
			...process.env,
			CAST_CWD: homedir(),
			CAST_SERVER_PORT: "0",
			CAST_SERVER_HOST: "127.0.0.1",
			CAST_SERVER_FOREGROUND: "0",
			CAST_VERSION: process.env.CAST_VERSION ?? "0.0.0",
		},
	});
	child.unref();
	// Wait for the state file to describe a live process with a real port.
	for (let i = 0; i < 100; i++) {
		const state = readLiveServerState();
		if (state) return state;
		await new Promise((r) => setTimeout(r, 100));
	}
	return undefined;
}

/** POST JSON and return the parsed body. Throws on non-2xx with the server's error text. */
export async function serverFetch(
	client: ServerClient,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (client.token) headers.Authorization = `Bearer ${client.token}`;
	const res = await fetch(`${client.baseUrl}${path}`, {
		method: init?.method ?? "GET",
		headers,
		...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	});
	const text = await res.text();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	return { status: res.status, data };
}

/** Create a session on the daemon. Returns the session id. */
export async function createServerSession(
	client: ServerClient,
	options: { persona?: string; model?: string; cwd?: string } = {},
): Promise<string> {
	const { status, data } = await serverFetch(client, "/api/sessions", {
		method: "POST",
		body: options,
	});
	if (status !== 201) {
		const msg =
			data && typeof data === "object" && "error" in data
				? String((data as { error: string }).error)
				: "create failed";
		throw new Error(msg);
	}
	return (data as { id: string }).id;
}

/**
 * Resolve the session id to use for a run: resume by explicit id, resume the
 * most recent session in cwd (--continue), or create a fresh one. Returns the
 * session id and whether it was resumed (affects SessionStart hooks).
 */
export async function ensureServerSession(
	client: ServerClient,
	options: { persona?: string; model?: string; cwd?: string; resumeId?: string; resumeRequested?: boolean },
): Promise<{ id: string; resumed: boolean }> {
	// Explicit id: GET hydrates it on the daemon (bridge.getSession → hydrateSession).
	if (options.resumeId) {
		const { status } = await serverFetch(client, `/api/sessions/${options.resumeId}`);
		if (status === 200) return { id: options.resumeId, resumed: true };
		throw new Error(`session ${options.resumeId} not found`);
	}
	// --continue: the most recent session in the same cwd (mirrors local
	// startup's mostRecentSessionForProject).
	if (options.resumeRequested) {
		const { status, data } = await serverFetch(client, "/api/sessions");
		if (status === 200) {
			const list = data as Array<{ id: string; cwd?: string; updatedAt?: string }>;
			const cwd = options.cwd ?? process.env.CAST_CWD;
			const match = [...list]
				.filter((s) => !cwd || s.cwd === cwd)
				.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
			if (match) return { id: match.id, resumed: true };
		}
	}
	const id = await createServerSession(client, {
		persona: options.persona,
		model: options.model,
		cwd: options.cwd,
	});
	return { id, resumed: false };
}

/** Submit a prompt to a daemon session (fire-and-forget; events arrive on the SSE stream). */
export async function submitServerChat(client: ServerClient, sessionId: string, text: string): Promise<void> {
	const { status, data } = await serverFetch(client, `/api/sessions/${sessionId}/chat`, {
		method: "POST",
		body: { text },
	});
	if (status !== 202) {
		const msg =
			data && typeof data === "object" && "error" in data
				? String((data as { error: string }).error)
				: "submit failed";
		throw new Error(msg);
	}
}

/** Run a slash command on a daemon session (the same surface the web UI's /command uses). */
export async function runServerCommand(client: ServerClient, sessionId: string, command: string): Promise<unknown> {
	const { status, data } = await serverFetch(client, `/api/sessions/${sessionId}/command`, {
		method: "POST",
		body: { command },
	});
	if (status !== 200) {
		const msg =
			data && typeof data === "object" && "error" in data
				? String((data as { error: string }).error)
				: "command failed";
		throw new Error(msg);
	}
	return (data as { result?: unknown }).result;
}

/** Set the session's mode (plan/build) on the daemon. */
export async function setServerMode(client: ServerClient, sessionId: string, mode: "plan" | "build"): Promise<void> {
	const { status } = await serverFetch(client, `/api/sessions/${sessionId}/mode`, {
		method: "POST",
		body: { mode },
	});
	if (status !== 202) throw new Error(`mode change failed (HTTP ${status})`);
}

/** Answer a pending question on a daemon session. */
export async function answerServerQuestion(client: ServerClient, sessionId: string, values: string[]): Promise<void> {
	const { status } = await serverFetch(client, `/api/sessions/${sessionId}/question`, {
		method: "POST",
		body: { values },
	});
	if (status !== 202) throw new Error(`answer failed (HTTP ${status})`);
}

/** Resolve a pending plan-done transition on a daemon session. */
export async function resolveServerPlanTransition(client: ServerClient, sessionId: string): Promise<void> {
	const { status } = await serverFetch(client, `/api/sessions/${sessionId}/plan-transition`, {
		method: "POST",
		body: { kind: "done" },
	});
	if (status !== 202) throw new Error(`plan transition failed (HTTP ${status})`);
}

/** Fetch the daemon's view of a session (mode, question, plan transition, status). */
export async function getServerSession(client: ServerClient, sessionId: string): Promise<Record<string, unknown>> {
	const { status, data } = await serverFetch(client, `/api/sessions/${sessionId}`);
	if (status !== 200) throw new Error(`session fetch failed (HTTP ${status})`);
	return data as Record<string, unknown>;
}

/**
 * Subscribe to a session's WebEvent stream until the given predicate resolves
 * (e.g. the turn ended). Calls onEvent for each parsed event. Resolves once
 * the predicate returns true or the stream closes.
 */
export function subscribeServerEvents(
	client: ServerClient,
	sessionId: string,
	onEvent: (event: import("./bridge.ts").WebEvent) => void,
	until: (event: import("./bridge.ts").WebEvent) => boolean,
): { done: Promise<void>; close: () => void } {
	const params = client.token ? `?token=${encodeURIComponent(client.token)}` : "";
	const source = new EventSource(`${client.baseUrl}/api/sessions/${sessionId}/events${params}`);
	let resolved = false;
	const done = new Promise<void>((resolve) => {
		source.onmessage = (ev) => {
			let event: import("./bridge.ts").WebEvent;
			try {
				event = JSON.parse(ev.data) as import("./bridge.ts").WebEvent;
			} catch {
				return;
			}
			onEvent(event);
			if (!resolved && until(event)) {
				resolved = true;
				source.close();
				resolve();
			}
		};
		source.onerror = () => {
			if (!resolved) {
				resolved = true;
				source.close();
				resolve();
			}
		};
	});
	return {
		done,
		close: () => {
			resolved = true;
			source.close();
		},
	};
}
