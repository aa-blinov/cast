/**
 * The running language servers, shared by every session in the process: one
 * per (server, workspace root), started the first time a file needs it. A
 * server that can't be found or fails to start is left alone for the rest of
 * the process; one that crashes is restarted on the next use, twice at most.
 * Idle servers are shut down, since each holds a project's index in memory.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings } from "../settings.ts";
import { type LspClient as Client, fileUri, LspClient, type LspDiagnostic } from "./client.ts";
import { BUILTIN_SERVERS, handlesFile, rootFor, type ServerDef, type ServerSpawn } from "./servers.ts";

export type { LspDiagnostic } from "./client.ts";

/** How long an edit waits for the server to report on the new text. */
export const DIAGNOSTICS_WAIT_MS = 5_000;
/** More publishes within this window supersede the first (tsserver sends an early empty one). */
const DIAGNOSTICS_DEBOUNCE_MS = 150;
const PULL_TIMEOUT_MS = 3_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const MAX_RESTARTS = 2;

const clients = new Map<string, Client>();
const spawning = new Map<string, Promise<Client | undefined>>();
const broken = new Map<string, string>();
const restarts = new Map<string, number>();
let reaper: NodeJS.Timeout | undefined;
let exitHooked = false;

/** `lsp: false` in settings, or CAST_LSP=off for one run (CI, the test suite). */
export function lspEnabled(): boolean {
	if (process.env.CAST_LSP === "off" || process.env.CAST_LSP === "0") return false;
	return loadSettings().lsp !== false;
}

/** Built-in servers with the user's overrides applied, plus the user's own. */
function serverDefs(): ServerDef[] {
	const custom = loadSettings().lspServers ?? {};
	const defs: ServerDef[] = [];
	for (const def of BUILTIN_SERVERS) {
		const override = custom[def.id];
		if (override?.disabled) continue;
		if (!override) {
			defs.push(def);
			continue;
		}
		defs.push({
			...def,
			extensions: override.extensions ?? def.extensions,
			resolve: override.command?.length
				? async () => spawnFromSetting(override.command!, override.env, override.initialization)
				: async (root, ctx) => {
						const spawn = await def.resolve(root, ctx);
						return spawn && withOverrides(spawn, override.env, override.initialization);
					},
		});
	}
	for (const [id, entry] of Object.entries(custom)) {
		if (entry.disabled || BUILTIN_SERVERS.some((d) => d.id === id)) continue;
		if (!entry.command?.length || !entry.extensions?.length) continue;
		defs.push({
			id,
			extensions: entry.extensions,
			rootMarkers: [],
			resolve: async () => spawnFromSetting(entry.command!, entry.env, entry.initialization),
		});
	}
	return defs;
}

function spawnFromSetting(
	command: string[],
	env?: Record<string, string>,
	initialization?: Record<string, unknown>,
): ServerSpawn {
	return {
		command: command[0]!,
		args: command.slice(1),
		env,
		initializationOptions: initialization,
		settings: initialization,
	};
}

function withOverrides(
	spawn: ServerSpawn,
	env?: Record<string, string>,
	initialization?: Record<string, unknown>,
): ServerSpawn {
	return {
		...spawn,
		env: { ...spawn.env, ...env },
		initializationOptions: initialization ?? spawn.initializationOptions,
		settings: initialization ?? spawn.settings,
	};
}

function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const client of clients.values()) client.kill();
	});
	reaper = setInterval(() => {
		const now = Date.now();
		for (const [key, client] of clients) {
			if (now - client.lastUsed > IDLE_SHUTDOWN_MS) {
				clients.delete(key);
				void client.shutdown();
			}
		}
	}, 60_000);
	reaper.unref();
}

async function start(def: ServerDef, root: string, key: string): Promise<Client | undefined> {
	let spawn: ServerSpawn | undefined;
	try {
		spawn = await def.resolve(root, { autoInstall: loadSettings().lspAutoInstall !== false });
	} catch (error) {
		broken.set(key, error instanceof Error ? error.message : String(error));
		return undefined;
	}
	if (!spawn) {
		broken.set(key, "not installed");
		return undefined;
	}
	const client = new LspClient({
		serverId: def.id,
		command: spawn.command,
		args: spawn.args,
		root,
		env: spawn.env,
		settings: spawn.settings,
		onExit: () => {
			// Shut down on purpose (idle, exit) means it was already unregistered.
			if (clients.get(key) !== client) return;
			clients.delete(key);
			const count = (restarts.get(key) ?? 0) + 1;
			restarts.set(key, count);
			if (count > MAX_RESTARTS)
				broken.set(key, `crashed ${count} times${client.stderr ? `: ${client.stderr.slice(-300)}` : ""}`);
		},
	});
	try {
		await client.initialize(spawn.initializationOptions);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		broken.set(key, client.stderr ? `${reason}: ${client.stderr.slice(-300)}` : reason);
		client.kill();
		return undefined;
	}
	hookExit();
	clients.set(key, client);
	return client;
}

function realRoot(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/** The running (or newly started) servers for a file. `boundary` bounds the root search. */
export async function clientsFor(file: string, boundary: string): Promise<Client[]> {
	if (!lspEnabled()) return [];
	const path = resolve(boundary, file);
	const out: Client[] = [];
	await Promise.all(
		serverDefs()
			.filter((def) => handlesFile(def, path))
			.map(async (def) => {
				const found = rootFor(def, path, boundary);
				if (!found) return;
				// One server per real directory, however a symlink reached it.
				const root = realRoot(found);
				if (def.applies && !def.applies(root)) return;
				const key = `${def.id}\u0000${root}`;
				if (broken.has(key)) return;
				const running = clients.get(key);
				if (running?.alive) {
					out.push(running);
					return;
				}
				let pending = spawning.get(key);
				if (!pending) {
					pending = start(def, root, key).finally(() => spawning.delete(key));
					spawning.set(key, pending);
				}
				const client = await pending;
				if (client) out.push(client);
			}),
	);
	return out;
}

/** Whether any server handles a file (without starting one). */
export function hasServerFor(file: string): boolean {
	return lspEnabled() && serverDefs().some((def) => handlesFile(def, file));
}

/**
 * Hands the file's current text to its servers and, with `wait`, waits for
 * what they make of it: a pull where the server supports one, else the next
 * publish (and any that follow within the debounce).
 */
export async function touchFile(file: string, boundary: string, wait: boolean): Promise<Client[]> {
	const path = resolve(boundary, file);
	if (!existsSync(path)) return [];
	const list = await clientsFor(path, boundary);
	const since = Date.now();
	for (const client of list) client.syncFile(path);
	if (wait) await Promise.all(list.map((client) => settle(client, path, since)));
	return list;
}

/** Open files a pull server re-checks after a change, since it never publishes on its own. */
const MAX_REPULL_FILES = 20;

async function settle(client: Client, path: string, since: number): Promise<void> {
	if (client.supportsPull) {
		// The changed file, and every other file it has open: a new signature
		// breaks callers, and a pull server won't say so unless asked.
		const others = client
			.openFiles()
			.filter((f) => f !== path)
			.slice(0, MAX_REPULL_FILES);
		await Promise.all([path, ...others].map((f) => client.pullDiagnostics(f, PULL_TIMEOUT_MS)));
		if (client.diagnosticsFor(path) !== undefined) return;
	}
	// A server may register pull diagnostics only after start-up: if it does
	// while we wait for a publish, ask it instead.
	await Promise.race([
		client.waitForDiagnostics(path, DIAGNOSTICS_WAIT_MS),
		client.waitForRegistration(DIAGNOSTICS_WAIT_MS),
	]);
	if (client.supportsPull && client.diagnosticsFor(path) === undefined) {
		await client.pullDiagnostics(path, PULL_TIMEOUT_MS);
		return;
	}
	if (!client.publishedSince(path, since)) return;
	// Take the last of a burst: wait while publishes keep coming.
	let last = Date.now();
	while (Date.now() - since < DIAGNOSTICS_WAIT_MS) {
		// biome-ignore lint/performance/noAwaitInLoops: each wait decides whether another is needed
		await new Promise((r) => setTimeout(r, DIAGNOSTICS_DEBOUNCE_MS));
		if (!client.publishedSince(path, last)) break;
		last = Date.now();
	}
}

/** Running servers that already have the file open: its diagnostics are current. */
export function openClientsFor(file: string): Client[] {
	return [...clients.values()].filter((c) => c.alive && c.isOpen(file));
}

/** Current diagnostics for a file across its servers, deduplicated. */
export function diagnosticsFor(file: string, list: Client[]): LspDiagnostic[] {
	const seen = new Set<string>();
	const out: LspDiagnostic[] = [];
	for (const client of list) {
		for (const d of client.diagnosticsFor(file) ?? []) {
			const key = JSON.stringify([d.range.start, d.range.end, d.severity, d.code, d.message]);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(d);
		}
	}
	return out;
}

/** Every file with diagnostics, from the given servers. */
export function allDiagnostics(list: Client[]): Map<string, LspDiagnostic[]> {
	const merged = new Map<string, LspDiagnostic[]>();
	for (const client of list) {
		for (const [uri, items] of client.allDiagnostics()) {
			merged.set(uri, [...(merged.get(uri) ?? []), ...items]);
		}
	}
	return merged;
}

/** Servers not starting, and why, for /lsp and error messages. */
export function lspStatus(): {
	running: Array<{ id: string; root: string }>;
	unavailable: Array<{ id: string; root: string; reason: string }>;
} {
	return {
		running: [...clients.values()].filter((c) => c.alive).map((c) => ({ id: c.serverId, root: c.root })),
		unavailable: [...broken].map(([key, reason]) => {
			const [id, root] = key.split("\u0000");
			return { id: id!, root: root!, reason };
		}),
	};
}

/** The /lsp report, the same text on every surface. */
export function formatLspStatus(status: ReturnType<typeof lspStatus>): string {
	if (!lspEnabled()) return "Language servers are off (setting `lsp`: false).";
	const lines: string[] = [];
	if (status.running.length === 0)
		lines.push("No language server running yet: one starts the first time a file needs it.");
	for (const s of status.running) lines.push(`running  ${s.id}  ${s.root}`);
	for (const s of status.unavailable) lines.push(`off      ${s.id}  ${s.root}  (${s.reason})`);
	return lines.join("\n");
}

export async function shutdownAllLspServers(): Promise<void> {
	const all = [...clients.values()];
	clients.clear();
	await Promise.all(all.map((c) => c.shutdown()));
}

/** Tests: forget every server and failure. */
export function resetLspForTests(): void {
	for (const client of clients.values()) client.kill();
	clients.clear();
	spawning.clear();
	broken.clear();
	restarts.clear();
}

export { fileUri };
