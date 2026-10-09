import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { withFileLock } from "./file-lock.ts";

/**
 * OAuth for remote MCP servers. The login is a person's act (a browser, a consent screen), so it runs only from
 * `/mcp auth <name>`; a connect never starts one. What it leaves is a token file: a server with tokens in it connects
 * with them (and the SDK refreshes them), a server without any connects as before and, on a 401, says what to run.
 */

/** Where the browser lands. Fixed, because the client registers it with the server once and every later
 *  authorization has to name the same address. */
export const MCP_AUTH_CALLBACK_PORT = 33418;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface StoredAuth {
	tokens?: OAuthTokens;
	clientInformation?: OAuthClientInformationMixed;
	codeVerifier?: string;
	/** Which server the entry belongs to: a server renamed to another URL must not reuse the old login. */
	url: string;
}

function authFilePath(): string {
	return join(homedir(), ".cast", "mcp-auth.json");
}

function readAll(): Record<string, StoredAuth> {
	try {
		return JSON.parse(readFileSync(authFilePath(), "utf-8")) as Record<string, StoredAuth>;
	} catch {
		return {};
	}
}

function writeAll(all: Record<string, StoredAuth>): void {
	const path = authFilePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, path);
	// The mode above only applies to a new file; a tighter one a person set must not be loosened, a looser one is fixed.
	if (existsSync(path)) chmodSync(path, 0o600);
}

function loadEntry(serverName: string, url: string): StoredAuth | undefined {
	const entry = readAll()[serverName];
	return entry && entry.url === url ? entry : undefined;
}

/** Every change to the token file is a read-modify-write, so it runs under the file's lock: two cast processes writing
 *  different servers at once otherwise drop each other's entries (measured: 2 to 15 of 16 kept without it). */
function updateEntry(serverName: string, url: string, change: (entry: StoredAuth) => void): void {
	withFileLock(`${authFilePath()}.lock`, () => {
		const all = readAll();
		const entry = all[serverName]?.url === url ? all[serverName]! : { url };
		change(entry);
		all[serverName] = entry;
		writeAll(all);
	});
}

/** Whether a login for this server is on file. */
export function hasMcpLogin(serverName: string, url: string): boolean {
	return Boolean(loadEntry(serverName, url)?.tokens);
}

/** Forget a server's login. True when there was one. */
export function clearMcpLogin(serverName: string): boolean {
	let removed = false;
	withFileLock(`${authFilePath()}.lock`, () => {
		const all = readAll();
		if (!(serverName in all)) return;
		delete all[serverName];
		writeAll(all);
		removed = true;
	});
	return removed;
}

export function callbackUrl(port = MCP_AUTH_CALLBACK_PORT): string {
	return `http://127.0.0.1:${port}/callback`;
}

/** What the SDK needs to attach a stored login to a connection and keep it fresh; `onRedirect` is the login's own. */
export function createMcpAuthProvider(
	serverName: string,
	url: string,
	options: { port?: number; onRedirect?: (authorizationUrl: URL) => void; state?: string } = {},
): OAuthClientProvider {
	const redirect = callbackUrl(options.port);
	const metadata: OAuthClientMetadata = {
		client_name: "cast",
		redirect_uris: [redirect],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	return {
		get redirectUrl() {
			return redirect;
		},
		get clientMetadata() {
			return metadata;
		},
		state: () => options.state ?? randomBytes(16).toString("hex"),
		clientInformation: () => loadEntry(serverName, url)?.clientInformation,
		saveClientInformation: (info) =>
			updateEntry(serverName, url, (e) => {
				e.clientInformation = info;
			}),
		tokens: () => loadEntry(serverName, url)?.tokens,
		saveTokens: (tokens) =>
			updateEntry(serverName, url, (e) => {
				e.tokens = tokens;
			}),
		saveCodeVerifier: (verifier) =>
			updateEntry(serverName, url, (e) => {
				e.codeVerifier = verifier;
			}),
		codeVerifier: () => {
			const verifier = loadEntry(serverName, url)?.codeVerifier;
			if (!verifier) throw new Error("No login is in progress for this server");
			return verifier;
		},
		invalidateCredentials: (scope) =>
			updateEntry(serverName, url, (e) => {
				if (scope === "all" || scope === "tokens") e.tokens = undefined;
				if (scope === "all" || scope === "client") e.clientInformation = undefined;
				if (scope === "all" || scope === "verifier") e.codeVerifier = undefined;
			}),
		redirectToAuthorization: (authorizationUrl) => options.onRedirect?.(authorizationUrl),
	};
}

/** A login the person has started and not yet finished. */
interface PendingLogin {
	authorizationUrl: string;
	state: string;
	/** Settles when this login is over, the connection rebuilt included. */
	finished: Promise<void>;
	finish: (codeOrCallback: string) => void;
	cancel: () => void;
}

const pending = new Map<string, PendingLogin>();

/** The `code` of what a person pasted: the whole address the browser ended at, or the bare code. */
export function authorizationCodeFrom(pasted: string, expectedState: string): string {
	const text = pasted.trim();
	if (!text.includes("=") && !text.includes("?")) return text;
	const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
	const params = new URLSearchParams(query.replace(/#.*$/, ""));
	const error = params.get("error");
	if (error) throw new Error(`The server refused the login: ${params.get("error_description") ?? error}`);
	const state = params.get("state");
	if (state !== null && state !== expectedState) throw new Error("That address belongs to a different login attempt");
	const code = params.get("code");
	if (!code) throw new Error("No authorization code in what was pasted");
	return code;
}

function listenForCallback(port: number, expectedState: string): { server: Server; code: Promise<string> } {
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	// A rejection nobody awaits yet (the login still being set up) must not crash the process.
	code.catch(() => {});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", callbackUrl(port));
		if (url.pathname !== "/callback") {
			res.writeHead(404).end();
			return;
		}
		// A visit without the redirect's query (a reload, a prefetch) carries no code: it must not resolve the login.
		if (!url.search) {
			res.writeHead(400).end();
			return;
		}
		try {
			resolveCode(authorizationCodeFrom(url.search, expectedState));
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<!doctype html><title>cast</title><p>Signed in. You can close this tab and go back to cast.</p>");
		} catch (error) {
			rejectCode(error instanceof Error ? error : new Error(String(error)));
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
			res.end(error instanceof Error ? error.message : String(error));
		}
	});
	return { server, code };
}

export interface McpLoginStarted {
	/** Where the person signs in. Empty when the server needed no login (a valid one was already on file). */
	authorizationUrl: string;
	/** Settles when the login is done, or fails: the browser came back, the paste was accepted, it timed out. */
	done: Promise<void>;
}

/**
 * Begin a login for a remote server: find out where the person must go, and wait for them to come back, either
 * through the loopback address (a browser on this machine) or through `finishMcpLogin` (a pasted address, for a
 * browser somewhere else).
 */
export async function startMcpLogin(
	serverName: string,
	url: string,
	headers?: Record<string, string>,
	/** Runs once the login is on file, to bring the server up with it; the login is over when this is. */
	afterLogin?: () => Promise<void>,
	port = MCP_AUTH_CALLBACK_PORT,
): Promise<McpLoginStarted> {
	pending.get(serverName)?.cancel();
	const state = randomBytes(16).toString("hex");
	let authorizationUrl = "";
	const provider = createMcpAuthProvider(serverName, url, {
		port,
		state,
		onRedirect: (target) => {
			authorizationUrl = target.toString();
		},
	});
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		authProvider: provider,
		requestInit: headers ? { headers } : undefined,
	});
	const client = new Client({ name: "cast", version: "1.0.0" });
	try {
		await client.connect(transport);
		await client.close().catch(() => {});
		return { authorizationUrl: "", done: Promise.resolve() };
	} catch (error) {
		await client.close().catch(() => {});
		if (!(error instanceof UnauthorizedError) || !authorizationUrl) throw error;
	}

	const listener = listenForCallback(port, state);
	await new Promise<void>((resolve, reject) => {
		listener.server.once("error", (error: NodeJS.ErrnoException) =>
			reject(
				error.code === "EADDRINUSE"
					? new Error(
							`Port ${port} is busy, and the login has to come back to it. Free it and run /mcp auth ${serverName} again.`,
						)
					: error,
			),
		);
		listener.server.listen(port, "127.0.0.1", resolve);
	});

	let settled = false;
	let resolveManual!: (code: string) => void;
	const manual = new Promise<string>((resolve) => {
		resolveManual = resolve;
	});
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`No one signed in within ${LOGIN_TIMEOUT_MS / 60_000} minutes`)),
			LOGIN_TIMEOUT_MS,
		);
		timer.unref?.();
	});
	let cancelLogin!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		cancelLogin = () => reject(new Error("A newer login for this server replaced this one"));
	});
	cancelled.catch(() => {});

	const done = (async () => {
		try {
			const code = await Promise.race([listener.code, manual, timeout, cancelled]);
			await transport.finishAuth(code);
			settled = true;
			await afterLogin?.();
		} finally {
			listener.server.close();
			pending.delete(serverName);
			if (!settled)
				updateEntry(serverName, url, (e) => {
					e.codeVerifier = undefined;
				});
		}
	})();
	done.catch(() => {});
	pending.set(serverName, {
		authorizationUrl,
		state,
		finished: done,
		cancel: cancelLogin,
		finish: (pasted) => resolveManual(authorizationCodeFrom(pasted, state)),
	});
	return { authorizationUrl, done };
}

/** Hand a pasted address (or bare code) to the login in progress for this server. */
export async function finishMcpLogin(serverName: string, pasted: string): Promise<void> {
	const login = pending.get(serverName);
	if (!login) throw new Error(`No login is waiting for "${serverName}". Run /mcp auth ${serverName} first.`);
	login.finish(pasted);
	await login.finished;
}

export function pendingMcpLoginUrl(serverName: string): string | undefined {
	return pending.get(serverName)?.authorizationUrl;
}

/**
 * `/mcp auth <name> [pasted address]` for both surfaces: starts the login and says where to go, or finishes it with
 * what was pasted. `afterLogin` brings the server up with the new login; `notify` hears how a login that was left
 * running in the background ended.
 */
export async function runMcpAuthCommand(
	serverName: string,
	config: { url?: string; headers?: Record<string, string> } | undefined,
	pasted: string,
	hooks: { afterLogin: () => Promise<void>; notify: (message: string) => void },
): Promise<string> {
	if (!config) return `No MCP server named "${serverName}". See /mcp list.`;
	if (!config.url) return `"${serverName}" runs on this machine; OAuth is for servers with a url.`;
	if (pasted) {
		await finishMcpLogin(serverName, pasted);
		return `Signed in to "${serverName}".`;
	}
	const started = await startMcpLogin(serverName, config.url, config.headers, hooks.afterLogin);
	if (!started.authorizationUrl) {
		await hooks.afterLogin();
		return `"${serverName}" needs no sign in: the login on file works.`;
	}
	void started.done.then(
		() => hooks.notify(`Signed in to MCP server "${serverName}".`),
		(error: unknown) =>
			hooks.notify(`Sign in to "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`),
	);
	return [
		`Sign in to "${serverName}": open this address in a browser.`,
		started.authorizationUrl,
		`When the browser lands on ${callbackUrl()} on this machine, cast finishes by itself. If the browser is on another machine, copy the address it ends at (it will not load) and run /mcp auth ${serverName} <that address>.`,
	].join("\n");
}
