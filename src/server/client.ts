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
import type { SessionState } from "../core/session.ts";
import { API_V1_PREFIX } from "./api-v1.ts";
import {
	acquireStartLock,
	clearServerState,
	DAEMON_STARTUP_TIMEOUT_MS,
	DaemonProtocolMismatchError,
	daemonBaseUrl,
	isCurrentDaemonInstance,
	isDaemonProtocolCompatible,
	readLiveServerState,
	releaseStartLock,
	type ServerDaemonState,
} from "./daemon-state.ts";

export interface ServerClient {
	baseUrl: string;
	token?: string;
}

const DAEMON_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Returns the running daemon's base URL + loopback token, starting one if
 * nothing is alive. Mirrors index.ts's ensureDaemon so headless surfaces
 * (cast run) attach to the same single persistent daemon the TUI uses.
 * Honors CAST_NO_DAEMON=1 by returning undefined (callers then fall back to
 * running locally, e.g. the JSONL runner during a transition).
 */
export async function ensureServerClient(): Promise<ServerClient | undefined> {
	if (process.env.CAST_NO_DAEMON === "1") return undefined;
	try {
		const clientFor = async (state: ServerDaemonState | undefined): Promise<ServerClient | undefined> => {
			if (!state) return undefined;
			if (!isDaemonProtocolCompatible(state)) throw new DaemonProtocolMismatchError(state);
			if (!(await isCurrentDaemonInstance(state))) {
				clearServerState();
				return undefined;
			}
			return { baseUrl: daemonBaseUrl(state), token: state.token };
		};
		// Same daemon-start race protection as index.ts's ensureDaemon: an
		// exclusive lock serializes the spawn so a concurrent TUI launch can't
		// stack a second daemon while this one's is still recording state.
		const waitForDaemon = async (attempt: number): Promise<ServerClient | undefined> => {
			if (attempt >= 100) return undefined;
			const existing = readLiveServerState();
			if (existing) {
				const client = await clientFor(existing);
				if (client) return client;
			}
			if (!acquireStartLock()) {
				await new Promise((r) => setTimeout(r, 100));
				return waitForDaemon(attempt + 1);
			}
			try {
				const now = readLiveServerState();
				if (now) {
					const client = await clientFor(now);
					if (client) return client;
				}
				const state = await spawnDetachedDaemon();
				return clientFor(state);
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
	// In dev (tsx) this module is src/server/client.ts → repo root is two
	// levels up; in release it is inlined into dist/index.js → repo root is
	// one level up from dist/. Match index.ts's spawnCwd accordingly.
	const spawnCwd = isRelease ? join(dirname(selfPath), "..") : join(dirname(selfPath), "..", "..");
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
	// Wait for the state file to describe a live process with a real port
	// (timeout after the shared startup budget). Interval-poll, not a for+await loop: keep the
	// pending timer unref'd so it can't hold the process open on a failure.
	const state = await new Promise<ServerDaemonState | undefined>((resolvePromise) => {
		let settled = false;
		const finish = (s: ServerDaemonState | undefined) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			resolvePromise(s);
		};
		const poll = setInterval(() => {
			const s = readLiveServerState();
			if (s) finish(s);
		}, 100);
		setTimeout(() => finish(undefined), DAEMON_STARTUP_TIMEOUT_MS).unref();
	});
	return state;
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
		signal: AbortSignal.timeout(DAEMON_REQUEST_TIMEOUT_MS),
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
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions`, {
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

/** Fork the daemon session's current safe context into a new idle session. */
export async function forkServerSession(client: ServerClient, sessionId: string): Promise<SessionState> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/fork`, {
		method: "POST",
	});
	if (status !== 201 || !data || typeof data !== "object" || !("session" in data)) {
		const message = data && typeof data === "object" && "error" in data ? String(data.error) : "fork failed";
		throw new Error(message);
	}
	return (data as { session: SessionState }).session;
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
		const { status } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${options.resumeId}`);
		if (status === 200) return { id: options.resumeId, resumed: true };
		throw new Error(`session ${options.resumeId} not found`);
	}
	// --continue: the most recent session in the same cwd (mirrors local
	// startup's mostRecentSessionForProject).
	if (options.resumeRequested) {
		const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions`);
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
export async function submitServerChat(
	client: ServerClient,
	sessionId: string,
	text: string,
	images?: string[],
): Promise<void> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/chat`, {
		method: "POST",
		body: { text, images },
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
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/command`, {
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
	const { status } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/mode`, {
		method: "POST",
		body: { mode },
	});
	// /mode replies 200 on success (unlike /chat and /question which use 202).
	if (status !== 200 && status !== 202) throw new Error(`mode change failed (HTTP ${status})`);
}

/** Answer a pending question on a daemon session. */
export async function answerServerQuestion(client: ServerClient, sessionId: string, values: string[]): Promise<void> {
	const { status } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/question`, {
		method: "POST",
		body: { values },
	});
	if (status !== 202) throw new Error(`answer failed (HTTP ${status})`);
}

/** Inject a steering message into a running turn. */
export async function steerServerSession(client: ServerClient, sessionId: string, message: string): Promise<void> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/steer`, {
		method: "POST",
		body: { message },
	});
	if (status !== 202) throw new Error(serverErrorMessage(data, "steer failed", status));
}

/** Queue a follow-up message to run after the current turn. */
export async function followUpServerSession(client: ServerClient, sessionId: string, message: string): Promise<void> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/followup`, {
		method: "POST",
		body: { message },
	});
	if (status !== 202) throw new Error(serverErrorMessage(data, "follow-up failed", status));
}

/** Abort the running turn. */
export async function abortServerSession(client: ServerClient, sessionId: string): Promise<void> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/abort`, {
		method: "POST",
	});
	if (status !== 200) throw new Error(serverErrorMessage(data, "abort failed", status));
}

/** Drop the session's in-context working set (the daemon's /clear). */
export async function cleanServerContext(client: ServerClient, sessionId: string): Promise<void> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/clean-context`, {
		method: "POST",
	});
	if (status !== 200) throw new Error(serverErrorMessage(data, "clean context failed", status));
}

function serverErrorMessage(data: unknown, fallback: string, status: number): string {
	return data && typeof data === "object" && "error" in data ? String(data.error) : `${fallback} (HTTP ${status})`;
}

/** Resolve a pending plan-done transition on a daemon session. */
export async function resolveServerPlanTransition(client: ServerClient, sessionId: string): Promise<void> {
	const { status } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}/plan-transition`, {
		method: "POST",
		body: { kind: "done" },
	});
	if (status !== 202) throw new Error(`plan transition failed (HTTP ${status})`);
}

/** Fetch the daemon's view of a session (mode, question, plan transition, status). */
export async function getServerSession(client: ServerClient, sessionId: string): Promise<Record<string, unknown>> {
	const { status, data } = await serverFetch(client, `${API_V1_PREFIX}/sessions/${sessionId}`);
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
	const source = new EventSource(`${client.baseUrl}${API_V1_PREFIX}/sessions/${sessionId}/events${params}`);
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
