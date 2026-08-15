/**
 * Web server — node:http, static files, REST API, SSE, and session auth.
 * Zero npm dependencies. Authentication stays server-side in an HttpOnly
 * cookie so the browser never replaces Cast's UI with its own prompt.
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { getDb } from "../core/db.ts";
import {
	listProjectMemory,
	listProjectMemoryArtifacts,
	listProjectMemoryCheckpoints,
	searchProjectMemory,
} from "../core/memory.ts";
import { getHistoryPage, getMessageImage, getSessionEvents } from "../core/session.ts";
import { loadSettings, updateSettings } from "../core/settings.ts";
import {
	countRecentLlmRequests,
	queryEndpointOverview,
	queryEndpointSeries,
	queryRecentLlmRequests,
	queryTelemetryOverview,
	queryTelemetrySeries,
	recordApiRequest,
} from "../core/telemetry.ts";
import { ensureSessionWorktree } from "../core/worktree.ts";
import {
	API_V1_PREFIX,
	apiV1OpenApiDocument,
	isStableApiV1Route,
	legacyPathForApiV1,
	OPENAPI_V1_PATH,
} from "./api-v1.ts";
import { reconcileActiveStream, SANDBOX_CWD, type ServerBridge, toDisplayMessages, type WebEvent } from "./bridge.ts";
import { readLiveServerState } from "./daemon-state.ts";
import { isBlockedAttachmentName, sessionInputsDir } from "./inputs.ts";

const PORT_RE = /:\d+$/;
const ROUTE_PARAM_RE = /:(\w+)/g;
const FILENAME_QUOTE_RE = /"/g;
const STREAM_BLOCKS_IMPORT_RE = /from\s+"\.\/stream-blocks\.js"/;
// Matches bare `./<name>.js` imports inside the top-level modules whose content
// changes during dev (app.js, settings-modal.js) — the negative lookahead
// skips any already-versioned `?v=…` so we don't double-stamp after the first
// pass. Without this, an edit to e.g. settings-appearance.js leaves the browser
// pinned to the stale module: dynamic imports inside app.js resolve by URL,
// and `max-age=3600` on the asset means `location.reload()` won't re-fetch
// even though the file content on disk is different.
const VERSIONED_LOCAL_IMPORT_RE = /from\s+"\.\/(?!\.)([\w-]+)\.js(?!\?v=)"/g;
// Local modules whose `./<name>.js` imports are rewritten with `?v=` inside
// app.js / settings-modal.js. assetVersion mixes these into the app.js hash so
// any change to one of them invalidates the cached app.js too.
const IMPORT_REWRITE_TARGETS = [
	"api",
	"cast-logo",
	"composer",
	"diff-panel",
	"directory-browser",
	"elapsed-timer",
	"file-explorer",
	"hotkeys",
	"icons",
	"inputs-explorer",
	"memory-explorer",
	"message",
	"message-submit",
	"modal-focus",
	"new-session-modal",
	"plan-cards",
	"settings-appearance",
	"settings-modal",
	"settings-model",
	"settings-panels",
	"share-modal",
	"sidebar",
	"sse-connection",
	"sse-events",
	"status-popover",
	"streaming-blocks",
	"use-panel-resize",
	"use-session-controller",
	"use-session-state",
	"use-workspace-state",
] as const;
const DIFF_FILE_RE = /b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".ttf": "font/ttf",
};

export interface WebServerOptions {
	port: number;
	/** Interface to bind — the caller decides the default (127.0.0.1 vs 0.0.0.0), this just binds what it's given. */
	host: string;
	bridge: ServerBridge;
	webUser: string;
	serverPassword: string;
	version: string;
	/** Per-process identity used by the CLI to avoid signalling a reused PID. */
	instanceId?: string;
	/** Fires once the server is actually bound and accepting connections. Receives the real bound port (not the requested one — may differ when 0 was passed for OS assignment). */
	onListening?: (port: number) => void;
	/** Fires on a listen failure (e.g. EADDRINUSE) instead of the process crashing on an unhandled error event. */
	onError?: (err: NodeJS.ErrnoException) => void;
}

export function startServer(options: WebServerOptions): ReturnType<typeof createServer> {
	const { port, host, bridge, webUser, serverPassword } = options;
	const publicDir = join(import.meta.dirname ?? ".", "public");

	console.log(`[cast server] auth enabled (user: ${webUser})`);

	const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
	const failedLogins = new Map<string, { attempts: number; expiresAt: number }>();
	const LOGIN_WINDOW_MS = 15 * 60 * 1000;
	const MAX_FAILED_LOGINS = 5;

	function readCookie(req: IncomingMessage, name: string): string | undefined {
		const cookies = req.headers.cookie;
		if (!cookies) return undefined;
		for (const part of cookies.split(";")) {
			const [key, ...value] = part.trim().split("=");
			if (key === name) return value.join("=");
		}
		return undefined;
	}

	function isAuthenticated(req: IncomingMessage): boolean {
		const token = readCookie(req, "cast_web_session");
		if (token) {
			const db = getDb();
			const tokenHash = createHash("sha256").update(token).digest("hex");
			const row = db.prepare("SELECT expires_at FROM web_sessions WHERE token_hash = ?").get(tokenHash) as
				| { expires_at: number }
				| undefined;
			if (!row) return false;
			if (row.expires_at <= Date.now()) {
				db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
				return false;
			}
			return true;
		}
		// Local daemon token: the TUI (same machine, same user) connects over
		// loopback with the Bearer token written into web.json at startup. Skips
		// the browser's interactive login. Only honored for loopback clients so a
		// remote daemon still requires the normal session cookie.
		const isLoopback =
			req.socket.remoteAddress === "127.0.0.1" ||
			req.socket.remoteAddress === "::1" ||
			req.socket.remoteAddress === "::ffff:127.0.0.1";
		if (isLoopback) {
			const auth = req.headers.authorization;
			if (auth?.startsWith("Bearer ")) {
				const candidate = auth.slice("Bearer ".length);
				const state = readLiveServerState();
				if (state?.token && candidate === state.token) return true;
			}
			// EventSource (browser + Node) can't set custom headers, so the loopback
			// TUI client passes its token as a `?token=` query param instead.
			const url = new URL(req.url ?? "", "http://localhost");
			const candidate = url.searchParams.get("token");
			if (candidate) {
				const state = readLiveServerState();
				if (state?.token && candidate === state.token) return true;
			}
		}
		return false;
	}

	function passwordsMatch(value: string): boolean {
		const expected = Buffer.from(serverPassword);
		const candidate = Buffer.from(value);
		return candidate.length === expected.length && timingSafeEqual(candidate, expected);
	}

	function sessionCookie(req: IncomingMessage, token: string, maxAge: number): string {
		const secure = "encrypted" in req.socket || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
		return `cast_web_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
	}

	function retryAfterLoginLimit(req: IncomingMessage): number | null {
		const address = req.socket.remoteAddress ?? "unknown";
		const record = failedLogins.get(address);
		if (!record) return null;
		if (record.expiresAt <= Date.now()) {
			failedLogins.delete(address);
			return null;
		}
		return record.attempts >= MAX_FAILED_LOGINS ? Math.ceil((record.expiresAt - Date.now()) / 1000) : null;
	}

	function recordFailedLogin(req: IncomingMessage): void {
		const address = req.socket.remoteAddress ?? "unknown";
		const now = Date.now();
		const previous = failedLogins.get(address);
		if (!previous || previous.expiresAt <= now) {
			if (failedLogins.size >= 10_000) failedLogins.clear();
			failedLogins.set(address, { attempts: 1, expiresAt: now + LOGIN_WINDOW_MS });
			return;
		}
		previous.attempts++;
	}

	function clearFailedLogins(req: IncomingMessage): void {
		failedLogins.delete(req.socket.remoteAddress ?? "unknown");
	}

	function requireAuth(res: ServerResponse, isApi: boolean): void {
		if (isApi) {
			json(res, { error: "Authentication required" }, 401);
			return;
		}
		res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
		res.end();
	}

	function setSecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'",
		);
		const forwardedProto = req.headers["x-forwarded-proto"];
		const isHttps =
			"encrypted" in req.socket ||
			(typeof forwardedProto === "string" && forwardedProto.split(",")[0]?.trim() === "https");
		const host = (req.headers.host ?? "").replace(PORT_RE, "").toLowerCase();
		if (isHttps || host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
			res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		}
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
	}

	// Helpers
	function json(res: ServerResponse, data: unknown, status = 200): void {
		// The /api/sessions/:id payload alone runs 0.5-1.5MB on a normal
		// agentic thread (every tool result is inlined) and multi-MB on a long
		// one — without compression, that's a full second of dead air on any
		// network below ~10MB/s, which is exactly what the "thread opens slowly
		// from the sidebar" symptom looks like to the user. The endpoint
		// always returns `Cache-Control: no-store` so the savings don't get
		// hidden behind a cached response. textAsset's compression path above
		// already does this for static assets; this is the same idea for API
		// JSON. Compressing in-process keeps the zero-npm-deps rule.
		//
		// gzip-only on purpose: brotliSync at default level can take 500ms+
		// on a 1MB payload, which is exactly the latency we're trying to
		// claw back. gzip at the default level is ~10ms on the same input and
		// still gets 2-3x compression on the kind of repetitive tool output
		// these payloads contain. If a future use-case needs the extra 5-10%
		// brotli saves, gate it on a `quality: number` option.
		const raw = JSON.stringify(data);
		const body = Buffer.from(raw);
		// Below this size, the compression CPU cost on the server exceeds the
		// transfer saving on any plausible link — only /api/sessions/:id
		// (and a few SSE-adjacent ones) actually need it, and those are all
		// well above the threshold. Skip and ship uncompressed for the rest.
		const COMPRESS_THRESHOLD = 8 * 1024;
		const accepts = (res.req as IncomingMessage & { headers: NodeJS.Dict<string | string[]> }).headers[
			"accept-encoding"
		] as string | undefined;
		let out: Buffer = body;
		const useGzip = body.length >= COMPRESS_THRESHOLD && accepts?.includes("gzip");
		if (useGzip) out = gzipSync(body);
		const headers: Record<string, string | number> = {
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
			"Content-Length": out.length,
		};
		if (useGzip) {
			headers["Content-Encoding"] = "gzip";
			// Don't let a downstream cache key on the encoded body — accept-
			// encoding varies per request, so the cache key must too.
			headers.Vary = "Accept-Encoding";
		}
		res.writeHead(status, headers);
		res.end(out);
	}

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	function createSseWriter(
		res: ServerResponse,
		unsubscribe: () => void,
	): {
		write: (event: string) => void;
		end: () => void;
		close: () => void;
	} {
		const pending: string[] = [];
		let pendingBytes = 0;
		const maxPendingBytes = 1024 * 1024;
		let closed = false;
		let blocked = false;
		let endRequested = false;
		const close = () => {
			if (closed) return;
			closed = true;
			pending.length = 0;
			pendingBytes = 0;
			res.off("drain", flush);
			unsubscribe();
		};
		const flush = () => {
			if (closed) return;
			blocked = false;
			while (pending.length > 0) {
				try {
					const event = pending.shift()!;
					pendingBytes -= Buffer.byteLength(event);
					if (!res.write(event)) {
						blocked = true;
						return;
					}
				} catch {
					close();
					return;
				}
			}
			if (endRequested) {
				res.end();
				close();
			}
		};
		const write = (event: string) => {
			if (closed || endRequested) return;
			if (blocked) {
				const eventBytes = Buffer.byteLength(event);
				if (pendingBytes + eventBytes > maxPendingBytes) {
					// A hidden or slow client reconnects and recovers history instead
					// of retaining an unbounded token backlog in this process.
					res.end();
					close();
					return;
				}
				pending.push(event);
				pendingBytes += eventBytes;
				return;
			}
			try {
				if (!res.write(event)) blocked = true;
			} catch {
				close();
			}
		};
		const end = () => {
			if (closed) return;
			endRequested = true;
			if (!blocked && pending.length === 0) {
				res.end();
				close();
			}
		};
		res.on("drain", flush);
		return { write, end, close };
	}

	function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
		let urlPath = req.url?.split("?")[0] ?? "/";
		if (urlPath === "/") urlPath = "/index.html";

		const filePath = join(publicDir, urlPath);
		// Prevent directory traversal
		if (!filePath.startsWith(publicDir)) {
			res.writeHead(403);
			res.end("Forbidden");
			return true;
		}

		try {
			const stat = statSync(filePath);
			if (!stat.isFile()) return false;
			const ext = extname(filePath);
			const mime = MIME_TYPES[ext] ?? "application/octet-stream";
			const assetVersion = (path: string): string => {
				const source = readFileSync(join(publicDir, path));
				const hash = createHash("sha256").update(source);
				if (path === "/app.js") {
					// app.js's served bytes are not just the file — the server also
					// stamps every `./<name>.js` import with a content hash. Mix the
					// transitive version map into the hash so the HTML picks up a new
					// URL whenever any of those import targets change (otherwise the
					// browser's `immutable` cache keeps the pre-rewrite body).
					for (const child of IMPORT_REWRITE_TARGETS) {
						hash.update(`${child}=${assetVersion(`/${child}.js`)};`);
					}
				}
				return hash.digest("hex").slice(0, 12);
			};
			let content: Buffer | string = readFileSync(filePath);
			if (ext === ".html") {
				content = content
					.toString("utf-8")
					.replace('href="/login.css"', `href="/login.css?v=${assetVersion("/login.css")}"`)
					.replace('href="/tokens.css"', `href="/tokens.css?v=${assetVersion("/tokens.css")}"`)
					.replace('href="/style.css"', `href="/style.css?v=${assetVersion("/style.css")}"`)
					.replace('href="/chat.css"', `href="/chat.css?v=${assetVersion("/chat.css")}"`)
					.replace('href="/tools.css"', `href="/tools.css?v=${assetVersion("/tools.css")}"`)
					.replace('href="/workspace.css"', `href="/workspace.css?v=${assetVersion("/workspace.css")}"`)
					.replace('href="/settings.css"', `href="/settings.css?v=${assetVersion("/settings.css")}"`)
					.replace('src="/app.js"', `src="/app.js?v=${assetVersion("/app.js")}"`)
					.replace('src="/login.js"', `src="/login.js?v=${assetVersion("/login.js")}"`);
			} else if (urlPath === "/app.js" || urlPath === "/settings-modal.js") {
				// Stamp every bare `./<local>.js` import with a content-hash
				// version query so the browser refetches them when the file
				// changes (see VERSIONED_LOCAL_IMPORT_RE comment). The
				// stream-blocks.js regex is now redundant — the generic one
				// covers it — but kept for clarity / narrower match.
				content = content
					.toString("utf-8")
					.replace(VERSIONED_LOCAL_IMPORT_RE, (_, name) => `from"./${name}.js?v=${assetVersion(`/${name}.js`)}"`)
					.replace(STREAM_BLOCKS_IMPORT_RE, `from"./stream-blocks.js?v=${assetVersion("/stream-blocks.js")}"`);
			}
			const accepts = req.headers["accept-encoding"] ?? "";
			const textAsset = [".html", ".css", ".js", ".mjs", ".json", ".svg"].includes(ext);
			const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
			const encoding =
				textAsset && accepts.includes("br") ? "br" : textAsset && accepts.includes("gzip") ? "gzip" : undefined;
			const body = encoding === "br" ? brotliCompressSync(raw) : encoding === "gzip" ? gzipSync(raw) : raw;
			const requestedVersion = new URL(req.url ?? "/", `http://localhost:${port}`).searchParams.get("v");
			const immutable = ext !== ".html" && requestedVersion === assetVersion(urlPath);
			res.writeHead(200, {
				"Content-Type": mime,
				"Content-Length": body.length,
				"Cache-Control":
					ext === ".html"
						? "no-cache"
						: immutable
							? "public, max-age=31536000, immutable"
							: "public, max-age=3600",
				...(encoding ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" } : {}),
			});
			res.end(body);
			return true;
		} catch (_) {
			return false;
		}
	}

	// Route matching
	type RouteHandler = (
		req: IncomingMessage,
		res: ServerResponse,
		params: Record<string, string>,
	) => void | Promise<void>;

	interface Route {
		method: string;
		pattern: RegExp;
		paramNames: string[];
		handler: RouteHandler;
	}

	const routes: Route[] = [];

	function route(method: string, path: string, handler: RouteHandler): void {
		const paramNames: string[] = [];
		const pattern = path.replace(ROUTE_PARAM_RE, (_match, name) => {
			paramNames.push(name);
			return "([^/]+)";
		});
		routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
	}

	function matchRoute(
		method: string,
		urlPath: string,
	): { handler: RouteHandler; params: Record<string, string> } | null {
		for (const r of routes) {
			if (r.method !== method) continue;
			const match = r.pattern.exec(urlPath);
			if (!match) continue;
			const params: Record<string, string> = {};
			r.paramNames.forEach((name, i) => {
				params[name] = match[i + 1]!;
			});
			return { handler: r.handler, params };
		}
		return null;
	}

	// API routes
	route("GET", "/api/openapi.json", (_req, res) => {
		json(res, apiV1OpenApiDocument);
	});

	route("GET", "/api/auth/session", (req, res) => {
		json(res, { authenticated: isAuthenticated(req) });
	});

	route("POST", "/api/auth/login", async (req, res) => {
		const retryAfter = retryAfterLoginLimit(req);
		if (retryAfter !== null) {
			res.setHeader("Retry-After", retryAfter);
			return json(res, { error: "Too many sign-in attempts. Try again later." }, 429);
		}
		let username = "";
		let password = "";
		try {
			const parsed = JSON.parse(await readBody(req)) as { username?: string; password?: string };
			username = parsed.username ?? "";
			password = parsed.password ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const validPassword = passwordsMatch(password);
		if (username !== webUser || !validPassword) {
			recordFailedLogin(req);
			return json(res, { error: "Invalid username or password" }, 401);
		}
		clearFailedLogins(req);
		const token = randomBytes(32).toString("base64url");
		const now = Date.now();
		const db = getDb();
		db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
		db.prepare("INSERT INTO web_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(
			createHash("sha256").update(token).digest("hex"),
			now,
			now + SESSION_TTL_SECONDS * 1000,
		);
		res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_TTL_SECONDS));
		json(res, { ok: true });
	});

	route("POST", "/api/auth/logout", (req, res) => {
		const token = readCookie(req, "cast_web_session");
		if (token)
			getDb()
				.prepare("DELETE FROM web_sessions WHERE token_hash = ?")
				.run(createHash("sha256").update(token).digest("hex"));
		res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
		json(res, { ok: true });
	});

	route("GET", "/api/personas", (_req, res) => {
		json(res, bridge.getPersonas());
	});

	// Cast web daemon state — the same file the CLI's `cast server status`
	// prints. Self-heals stale entries (process gone → file cleaned up by
	// readLiveServerState), so the answer is always "what's actually running
	// right now" rather than "what's on disk from the last start".
	route("GET", "/api/server/status", (_req, res) => {
		const state = readLiveServerState();
		if (!state) return json(res, { running: false });
		json(res, {
			running: true,
			pid: state.pid,
			host: state.host,
			port: state.port,
			startedAt: state.startedAt,
			foreground: state.foreground,
		});
	});

	// ── LLM telemetry (dashboard) ──────────────────────────────────────────
	// Aggregates over the llm_requests table; all read-only. `since` is hours
	// back (default 24), `resolution` is minutes per bucket (default 60).
	route("GET", "/api/telemetry/overview", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const hours = Number(url.searchParams.get("since")) || 24;
		const sinceMs = Date.now() - hours * 60 * 60 * 1000;
		json(res, { sinceMs, rows: queryTelemetryOverview(sinceMs) });
	});

	route("GET", "/api/telemetry/series", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const hours = Number(url.searchParams.get("since")) || 24;
		const resolutionMin = Number(url.searchParams.get("resolution")) || 60;
		const sinceMs = Date.now() - hours * 60 * 60 * 1000;
		json(res, {
			sinceMs,
			resolutionMs: resolutionMin * 60 * 1000,
			buckets: queryTelemetrySeries(sinceMs, resolutionMin * 60 * 1000),
		});
	});

	route("GET", "/api/telemetry/recent", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
		const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
		const hours = Number(url.searchParams.get("since")) || 24;
		const sinceMs = Date.now() - hours * 60 * 60 * 1000;
		json(res, {
			rows: queryRecentLlmRequests(limit, offset, sinceMs),
			total: countRecentLlmRequests(sinceMs),
			offset,
			limit,
		});
	});

	route("GET", "/api/telemetry/endpoints", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const hours = Number(url.searchParams.get("since")) || 24;
		json(res, {
			sinceMs: Date.now() - hours * 60 * 60 * 1000,
			rows: queryEndpointOverview(Date.now() - hours * 60 * 60 * 1000),
		});
	});

	route("GET", "/api/telemetry/endpoint-series", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const hours = Number(url.searchParams.get("since")) || 24;
		const resolutionMin = Number(url.searchParams.get("resolution")) || 60;
		const sinceMs = Date.now() - hours * 60 * 60 * 1000;
		json(res, {
			sinceMs,
			resolutionMs: resolutionMin * 60 * 1000,
			buckets: queryEndpointSeries(sinceMs, resolutionMin * 60 * 1000),
		});
	});

	// Auth is enforced by the common API gate below. The local CLI compares
	// this with server.json before stopping a PID, so a stale state record can
	// never terminate an unrelated process that reused the numeric PID.
	route("GET", "/api/server/identity", (_req, res) => {
		json(res, { instanceId: options.instanceId });
	});

	// Lightweight git probe for the new-session modal: lets the UI show or
	// hide the worktree section based on whether `cwd` is inside a git
	// checkout with at least one commit. Cheap (one git rev-parse per
	// request, with a hard 2s timeout) so the modal can call it on every
	// cwd change without blocking the user.
	route("GET", "/api/git-info", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const cwd = url.searchParams.get("cwd") ?? "";
		if (!cwd || cwd === SANDBOX_CWD) {
			// Sandbox sessions have no git context — the modal hides the
			// worktree section whenever sandbox is picked, so an empty
			// response is exactly what the client wants.
			return json(res, { isGit: false });
		}
		const run = (args: string[]) => {
			try {
				return execFileSync("git", args, {
					cwd,
					encoding: "utf-8",
					timeout: 2000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
			} catch {
				return null;
			}
		};
		const inside = run(["rev-parse", "--is-inside-work-tree"]);
		if (inside !== "true") {
			return json(res, { isGit: false, cwd });
		}
		const head = run(["rev-parse", "HEAD"]);
		json(res, {
			isGit: true,
			hasCommits: !!head,
			branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "—",
			cwd,
		});
	});

	route("GET", "/api/sessions", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const q = url.searchParams.get("q");
		json(res, q ? bridge.searchSessions(q) : bridge.listSessions());
	});

	route("POST", "/api/sessions", async (req, res) => {
		const body = await readBody(req);
		let persona: string | undefined;
		let model: string | undefined;
		let cwd: string | undefined;
		let worktree: string | undefined;
		try {
			const parsed = JSON.parse(body) as {
				persona?: string;
				model?: string;
				cwd?: string;
				worktree?: string;
			};
			persona = parsed.persona;
			model = parsed.model;
			cwd = parsed.cwd;
			worktree = parsed.worktree;
		} catch {
			// empty body is fine
		}
		// Worktree and sandbox are mutually exclusive: a sandbox is a throwaway
		// scratch dir under ~/.cast/sandbox/, a worktree is a real checkout of
		// the repo's working tree. Picking both would nest one inside the
		// other in undefined ways. The bridge also enforces this defensively;
		// the check here just gives the client a clean 400 instead of a
		// silent preference.
		if (worktree && cwd === SANDBOX_CWD) {
			return json(res, { error: "Worktree mode is incompatible with sandbox mode" }, 400);
		}
		// Clients passing an explicit sandbox path (pre-SANDBOX_CWD-sentinel) still
		// get it created for them; the current "new" button sends the sentinel and
		// the bridge derives/creates the dir itself.
		if (cwd?.includes(".cast/sandbox/cast-")) {
			try {
				mkdirSync(cwd, { recursive: true });
			} catch {}
		}
		let wtPath: string | undefined;
		if (worktree) {
			const sourceCwd = cwd && cwd !== SANDBOX_CWD ? cwd : bridge.getConfig().cwd;
			try {
				const wt = await ensureSessionWorktree(worktree, sourceCwd);
				wtPath = wt.path;
			} catch (err) {
				// ensureSessionWorktree throws a user-readable message on every
				// failure mode (not a git repo, no commits, invalid slug, etc.) —
				// surface it as-is so the client can show the right hint.
				const message = err instanceof Error ? err.message : String(err);
				return json(res, { error: message }, 400);
			}
		}
		const ws = bridge.createSession(persona, model, wtPath ?? cwd, true);
		json(res, { id: ws.id, session: ws.session }, 201);
	});

	route("POST", "/api/sessions/:id/fork", (_req, res, params) => {
		const source = bridge.getSession(params.id);
		if (!source) return json(res, { error: "Not found" }, 404);
		if (source.status === "running") return json(res, { error: "Agent running — abort before forking" }, 409);
		const fork = bridge.forkSession(params.id);
		if (!fork) return json(res, { error: "Could not fork session" }, 400);
		json(res, { id: fork.id, session: fork.session }, 201);
	});

	// One stream per browser tab, independent of which session (if any) is
	// currently open — lets the sidebar's message-count badges update live
	// for background threads instead of only refreshing on a page reload.
	// Must stay registered before /api/sessions/:id below — that pattern's
	// single-segment `:id` would otherwise swallow "events" as an id first
	// (routes are matched in registration order) and this route would never
	// be reached, which is exactly what happened before this comment existed.
	route("GET", "/api/sessions/events", (req, res) => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		// Without an initial write, writeHead's headers sit unflushed until the
		// first real event — which for a quiet sidebar can be minutes away — so
		// the client's EventSource never reaches readyState OPEN and just hangs.
		const listener = (event: WebEvent) => {
			writer.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const writer = createSseWriter(res, () => bridge.unsubscribeAll(listener));
		writer.write(": connected\n\n");
		bridge.subscribeAll(listener);

		const heartbeat = setInterval(() => {
			writer.write(": keepalive\n\n");
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			writer.close();
		});
	});

	route("GET", "/api/sessions/:id", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		// Most recent page of full history, not ws.session.messages (which is
		// only the in-context working set once compaction has shrunk it) and
		// not the *entire* history (which for a long-lived, heavily-compacted
		// session can run to thousands of messages / megabytes — the scroll-up
		// pagination below, GET /api/sessions/:id/history, is how the client
		// fetches further back). turns query param lets a client ask for more
		// than the default up front (unused today, room for e.g. a "?turns=200"
		// power-user setting later).
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const turns = Number(url.searchParams.get("turns")) || undefined;
		const page = getHistoryPage(params.id, undefined, turns);
		const apiPrefix = (req.url ?? "").startsWith(API_V1_PREFIX) ? API_V1_PREFIX : "/api";
		const reconciled = reconcileActiveStream(
			toDisplayMessages(page.messages, page.reasoning, page.turnMeta, ws.id, page.seqs, apiPrefix),
			ws.activeStream,
		);
		json(res, {
			id: ws.id,
			persona: ws.session.persona,
			model: ws.session.model,
			cwd: ws.session.cwd,
			mode: ws.session.mode ?? "build",
			question: bridge.getQuestion(ws.id),
			planTransition: bridge.getPlanTransition(ws.id),
			title: ws.session.title,
			pinned: ws.session.pinned,
			shareToken: ws.session.shareToken ?? null,
			status: ws.status,
			turnStartedAt: ws.turnStartedAt ?? null,
			streaming: reconciled.streaming,
			// turnMeta is per-message now (see toDisplayMessages) — each
			// assistant reply carries its own "provider · model · Ns" footer,
			// persisted to disk, instead of a single session-level "last turn"
			// value that only ever covered the most recent one.
			messages: reconciled.messages,
			oldestSeq: page.oldestSeq ?? null,
			hasMoreHistory: page.hasMore,
			usage: ws.session.usage,
			createdAt: ws.session.createdAt,
			updatedAt: ws.session.updatedAt,
		});
	});

	// Scroll-up pagination: older turns before `before` (a seq from a
	// previous response's oldestSeq/hasMoreHistory). Always cut on a turn
	// boundary (see getHistoryPage) so a page never splits a tool_calls/tool
	// pair across the fetch.
	route("GET", "/api/sessions/:id/history", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const before = Number(url.searchParams.get("before"));
		if (!Number.isFinite(before)) return json(res, { error: "Missing/invalid 'before' seq" }, 400);
		const turns = Number(url.searchParams.get("turns")) || undefined;
		const page = getHistoryPage(params.id, before, turns);
		json(res, {
			messages: toDisplayMessages(
				page.messages,
				page.reasoning,
				page.turnMeta,
				params.id,
				page.seqs,
				(req.url ?? "").startsWith(API_V1_PREFIX) ? API_V1_PREFIX : "/api",
			),
			oldestSeq: page.oldestSeq ?? null,
			hasMoreHistory: page.hasMore,
		});
	});

	// Project memory is durable across sessions, but the cwd is always resolved
	// through the requested session so a browser cannot browse another project
	// by supplying an arbitrary filesystem path.
	route("GET", "/api/sessions/:id/memory", (req, res, params) => {
		const cwd = sessionCwd(params.id);
		if (!cwd) return json(res, { error: "Not found" }, 404);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const query = (url.searchParams.get("q") ?? "").trim();
		const items = query ? searchProjectMemory(cwd, query, 100) : listProjectMemory(cwd, 100);
		json(res, {
			cwd,
			projectId: items[0]?.projectId ?? null,
			query,
			items,
			checkpoint: query ? null : (listProjectMemoryCheckpoints(cwd, 1)[0] ?? null),
			artifacts: query ? [] : listProjectMemoryArtifacts(cwd, 20),
			hasMore: items.length >= 100,
		});
	});

	// Audit trail of live agent events (tool_start, retry, doom_loop, error,
	// end, …) — see session_events in db.ts. Deliberately not part of the
	// conversation history: this is execution telemetry.
	route("GET", "/api/sessions/:id/events/history", (_req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		json(res, { events: getSessionEvents(params.id) });
	});

	// Raw bytes for one image embedded in a `read`-on-image-file message (see
	// core/session.ts's getMessageImage) — toDisplayMessages points `images`
	// at this instead of inlining the data: URL, so a handful of photos in a
	// thread doesn't turn every session/history load into a multi-MB payload.
	route("GET", "/api/sessions/:id/image", (req, res, params) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const seq = Number(url.searchParams.get("seq"));
		const idx = Number(url.searchParams.get("idx"));
		if (!Number.isFinite(seq) || !Number.isFinite(idx)) return json(res, { error: "Missing/invalid seq/idx" }, 400);
		const image = getMessageImage(params.id, seq, idx);
		if (!image) return json(res, { error: "Not found" }, 404);
		res.writeHead(200, {
			"Content-Type": image.mimeType,
			"Content-Length": image.buffer.length,
			// Content at a given (session, seq, idx) never changes once written.
			"Cache-Control": "private, max-age=31536000, immutable",
		});
		res.end(image.buffer);
	});

	route("DELETE", "/api/sessions/:id", (_req, res, params) => {
		const closed = bridge.closeSession(params.id);
		if (!closed) return json(res, { error: "Not found" }, 404);
		json(res, { ok: true });
	});

	// Permanently removes the session from disk — unlike the plain DELETE
	// above, which only unloads it from the live runner (see closeSession's
	// own doc comment). A distinct route rather than a query flag on the same
	// one, since the two have very different blast radii.
	route("DELETE", "/api/sessions/:id/permanent", (_req, res, params) => {
		const deleted = bridge.deleteSessionPermanently(params.id);
		if (!deleted) return json(res, { error: "Not found" }, 404);
		json(res, { ok: true });
	});

	route("POST", "/api/sessions/:id/rename", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let title: string;
		try {
			const parsed = JSON.parse(body) as { title?: string };
			title = parsed.title ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		bridge.renameSession(params.id, title);
		json(res, { ok: true, title: ws.session.title });
	});

	route("POST", "/api/sessions/:id/pin", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let pinned: boolean;
		try {
			const parsed = JSON.parse(body) as { pinned?: boolean };
			pinned = Boolean(parsed.pinned);
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		bridge.pinSession(params.id, pinned);
		json(res, { ok: true, pinned: Boolean(ws.session.pinned) });
	});

	route("POST", "/api/sessions/:id/share", (_req, res, params) => {
		const shared = bridge.shareSession(params.id);
		if (!shared) return json(res, { error: "Not found" }, 404);
		json(res, { ok: true, token: shared.token, url: `/shared/${shared.token}` });
	});

	route("DELETE", "/api/sessions/:id/share", (_req, res, params) => {
		const revoked = bridge.unshareSession(params.id);
		json(res, { ok: revoked });
	});

	// A single image's data: URL, resized+re-encoded client-side (see app.js's
	// resizeImageToDataUrl) before it ever reaches here — this cap is defense
	// in depth against a client that skips that step, not the primary
	// control. Matches the incident this whole feature was built after: 8
	// unresized photos in one request got a bare, undebuggable 400 from the
	// provider — reject oversized/too-numerous images up front with an
	// actual explanation instead of forwarding them and letting that happen
	// again several turns later.
	const MAX_IMAGES_PER_MESSAGE = 6;
	const MAX_IMAGE_DATA_URL_BYTES = 4 * 1024 * 1024;

	route("POST", "/api/sessions/:id/chat", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let text: string;
		let images: string[] | undefined;
		let clientMessageId: string | undefined;
		try {
			const parsed = JSON.parse(body) as { text?: string; images?: string[]; clientMessageId?: unknown };
			text = parsed.text ?? "";
			images = Array.isArray(parsed.images) && parsed.images.length > 0 ? parsed.images : undefined;
			clientMessageId = typeof parsed.clientMessageId === "string" ? parsed.clientMessageId.trim() : undefined;
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!text.trim() && !images) return json(res, { error: "Empty message" }, 400);
		if (images) {
			if (images.length > MAX_IMAGES_PER_MESSAGE) {
				return json(res, { error: `Too many images — max ${MAX_IMAGES_PER_MESSAGE} per message` }, 400);
			}
			const tooBig = images.find((url) => url.length > MAX_IMAGE_DATA_URL_BYTES);
			if (tooBig) return json(res, { error: "One of the images is too large" }, 400);
		}
		try {
			await bridge.submit(params.id, text, images, clientMessageId);
		} catch (error) {
			return json(res, { error: error instanceof Error ? error.message : "Could not accept message" }, 500);
		}
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/question", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let values: string[];
		try {
			const parsed = JSON.parse(body) as { values?: unknown };
			values =
				Array.isArray(parsed.values) && parsed.values.every((value) => typeof value === "string")
					? parsed.values
					: [];
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = bridge.answerQuestion(params.id, values);
		if (!result.ok) return json(res, { error: result.error }, result.error === "Agent running" ? 409 : 400);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/plan-transition", async (req, res, params) => {
		const body = await readBody(req);
		let kind: "done";
		try {
			const parsed = JSON.parse(body) as { kind?: string };
			if (parsed.kind !== "done") return json(res, { error: "Invalid plan transition" }, 400);
			kind = parsed.kind;
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = bridge.resolvePlanTransition(params.id, kind);
		if (!result.ok) return json(res, { error: result.error }, result.error === "Agent running" ? 409 : 400);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/mode", async (req, res, params) => {
		const body = await readBody(req);
		let mode: "plan" | "build";
		try {
			const parsed = JSON.parse(body) as { mode?: string };
			if (parsed.mode !== "plan" && parsed.mode !== "build") {
				return json(res, { error: 'Mode must be "plan" or "build"' }, 400);
			}
			mode = parsed.mode;
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = bridge.setSessionMode(params.id, mode);
		if (!result.ok) return json(res, { error: result.error }, result.error === "Agent running" ? 409 : 400);
		json(res, { ok: true });
	});

	route("POST", "/api/sessions/:id/clean-context", (_req, res, params) => {
		const result = bridge.resetContext(params.id);
		if (!result.ok) return json(res, { error: result.error }, result.error === "Agent running" ? 409 : 400);
		json(res, result);
	});

	route("POST", "/api/sessions/:id/abort", (_req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		bridge.abort(params.id);
		json(res, { ok: true });
	});

	route("POST", "/api/sessions/:id/steer", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let message: string;
		try {
			const parsed = JSON.parse(body) as { message?: string };
			message = parsed.message ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!message.trim()) return json(res, { error: "Empty message" }, 400);
		bridge.steer(params.id, message);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/followup", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let message: string;
		try {
			const parsed = JSON.parse(body) as { message?: string };
			message = parsed.message ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!message.trim()) return json(res, { error: "Empty message" }, 400);
		bridge.followUp(params.id, message);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/command", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let command: string;
		try {
			const parsed = JSON.parse(body) as { command?: string };
			command = parsed.command ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = await bridge.executeCommand(params.id, command);
		if (!result.ok) {
			const status = result.error?.includes("Agent running") ? 409 : 400;
			return json(res, { error: result.error }, status);
		}
		json(res, { ok: true, result: result.result });
	});

	route("POST", "/api/settings/command", async (req, res) => {
		const body = await readBody(req);
		let command: string;
		try {
			const parsed = JSON.parse(body) as { command?: string };
			command = parsed.command ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const result = await bridge.executeSettingsCommand(command);
		if (!result.ok) return json(res, { error: result.error }, 400);
		json(res, { ok: true, result: result.result });
	});

	route("GET", "/api/sessions/:id/events", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		const listener = (event: WebEvent) => {
			writer.write(`data: ${JSON.stringify(event)}\n\n`);
			// The session is gone from the bridge's map by the time this fires —
			// nothing left to unsubscribe from, just end the stream so the
			// client's EventSource doesn't spend its retry budget on a 404.
			if (event.type === "session_closed") writer.end();
		};
		const writer = createSseWriter(res, () => bridge.unsubscribe(params.id, listener));
		// Send current status immediately
		writer.write(`data: ${JSON.stringify({ type: "status", status: ws.status, startedAt: ws.turnStartedAt })}\n\n`);
		bridge.subscribe(params.id, listener);

		// Heartbeat
		const heartbeat = setInterval(() => {
			writer.write(": keepalive\n\n");
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			writer.close();
		});
	});

	route("GET", "/api/sessions/:id/diff", (_req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);

		const targetCwd = ws.session.cwd ?? process.cwd();

		try {
			execSync("git rev-parse --is-inside-work-tree", {
				cwd: targetCwd,
				encoding: "utf-8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return json(res, { files: [], groups: emptyGroups(), noRepo: true });
		}

		const git = (args: string[]) =>
			execSync(`git ${args.join(" ")}`, {
				cwd: targetCwd,
				encoding: "utf-8",
				timeout: 10_000,
				maxBuffer: 5 * 1024 * 1024,
			});

		// git diff returns exit code 1 when files differ — that's expected,
		// not an error. execSync throws on any non-zero exit, so we catch
		// code-1 and return stdout normally.
		const gitDiff = (args: string[]): string => {
			try {
				return git(args);
			} catch (err: unknown) {
				const e = err as { status?: number; stdout?: string };
				if (e.status === 1 && typeof e.stdout === "string") return e.stdout;
				throw err;
			}
		};

		try {
			const status = git(["status", "--porcelain", "-u"]);
			const groups: FileGroups = { untracked: [], added: [], modified: [], deleted: [], renamed: [] };
			const diffTargets: Array<{ path: string; args: string[] }> = [];

			for (const line of status.split("\n")) {
				if (line.length < 4) continue;
				const xy = line.slice(0, 2);
				const path = line.slice(3).split(" -> ").pop()!;
				if (path.startsWith(".cast/") || path.includes("/.cast/")) continue;

				if (xy === "??") {
					groups.untracked.push(path);
					diffTargets.push({
						path,
						args: ["diff", "--no-color", "--unified=3", "--no-index", "--", "/dev/null", path],
					});
				} else if (xy === "A " || xy === "A" + " ") {
					groups.added.push(path);
					diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--staged", "--", path] });
				} else if (xy === "R ") {
					groups.renamed.push(path);
					diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--staged", "--", path] });
				} else if (xy === "D " || xy === " D") {
					groups.deleted.push(path);
					if (xy[0] === " ") diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--", path] });
					else diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--staged", "--", path] });
				} else if (xy[0] === "M" || xy[1] === "M" || xy === "AM") {
					groups.modified.push(path);
					// Unstaged diff (working tree vs index)
					if (xy[1] === "M" || xy[1] === " ") {
						diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--", path] });
					}
					// Staged diff (index vs HEAD) — append suffix to avoid key collision
					if (xy[0] === "M" || xy[0] === "A") {
						diffTargets.push({
							path: `${path}:staged`,
							args: ["diff", "--no-color", "--unified=3", "--staged", "--", path],
						});
					}
				} else {
					// Catch-all: anything else with changes goes to modified
					groups.modified.push(path);
					diffTargets.push({ path, args: ["diff", "--no-color", "--unified=3", "--", path] });
				}
			}

			// Cap untracked to avoid huge diffs on first-open repos
			const maxUntracked = 50;
			if (diffTargets.filter((t) => groups.untracked.includes(t.path)).length > maxUntracked) {
				const untrackedPaths = new Set(groups.untracked);
				let kept = 0;
				const filtered = diffTargets.filter((t) => {
					if (!untrackedPaths.has(t.path)) return true;
					kept++;
					return kept <= maxUntracked;
				});
				diffTargets.length = 0;
				diffTargets.push(...filtered);
				groups.untracked = groups.untracked.slice(0, maxUntracked);
			}

			// Run per-file diffs in parallel batches
			const allFiles: DiffFile[] = [];
			const batchSize = 10;
			for (let i = 0; i < diffTargets.length; i += batchSize) {
				const batch = diffTargets.slice(i, i + batchSize);
				const results = batch.map((t) => {
					try {
						const raw = gitDiff(t.args);
						return parseDiff(raw).files;
					} catch {
						return [] as DiffFile[];
					}
				});
				for (let j = 0; j < results.length; j++) {
					for (const f of results[j]) {
						// Unstrip the :staged suffix we added for collision avoidance
						const target = batch[j]!;
						if (target.path.endsWith(":staged")) {
							f.path = target.path.slice(0, -7);
						}
						allFiles.push(f);
					}
				}
			}

			json(res, { files: allFiles, groups });
		} catch (err) {
			json(res, { files: [], groups: emptyGroups(), error: err instanceof Error ? err.message : String(err) });
		}
	});

	// True whenever `target` is `root` itself or somewhere underneath it — the
	// one check every /fs/* route below relies on to keep a session's file
	// browser from reading/downloading/deleting anything outside its own cwd,
	// no matter what `..`-laden path a request sends.
	function isInsideRoot(root: string, target: string): boolean {
		const rel = relative(root, target);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}

	function sessionCwd(sessionId: string): string | null {
		const ws = bridge.getSession(sessionId);
		if (!ws) return null;
		return resolve(ws.session.cwd ?? bridge.getConfig().cwd);
	}

	// Single-directory, lazy listing — the client fetches one level at a time
	// as folders are expanded, rather than one eager recursive walk. Without
	// respecting .gitignore (deliberately, for now) a project's node_modules
	// alone can be tens of thousands of entries; lazy listing keeps every
	// request cheap regardless of project size.
	route("GET", "/api/sessions/:id/fs", (req, res, params) => {
		const cwd = sessionCwd(params.id);
		if (!cwd) return json(res, { error: "Not found" }, 404);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const target = resolve(cwd, url.searchParams.get("path") || ".");
		if (!isInsideRoot(cwd, target)) return json(res, { error: "Path outside project" }, 400);
		try {
			const st = statSync(target);
			if (!st.isDirectory()) return json(res, { error: "Not a directory" }, 400);
			const entries = readdirSync(target, { withFileTypes: true })
				.filter((e) => e.name !== ".git")
				.map((e) => {
					const full = join(target, e.name);
					const isDir = e.isDirectory();
					let size: number | undefined;
					if (!isDir) {
						try {
							size = statSync(full).size;
						} catch {
							size = undefined;
						}
					}
					return { name: e.name, type: isDir ? "dir" : "file", size };
				})
				.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
			json(res, { path: relative(cwd, target), entries });
		} catch (err) {
			// A brand-new sandbox session's cwd (see bridge.ts's SANDBOX_CWD) is
			// only created lazily on the first submitted message, not at session
			// creation — the Files panel loading before that first send is a
			// completely normal state, not an error. Without this, the raw ENOENT
			// ("no such file or directory, stat '...'") surfaced verbatim in the
			// UI, reading like a crash for something that just hadn't happened yet.
			if (target === cwd && (err as NodeJS.ErrnoException)?.code === "ENOENT") {
				return json(res, { path: "", entries: [] });
			}
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Recursive name search across the whole project tree (not just expanded
	// folders) — a synchronous walk, capped on both matches and nodes visited
	// so a query with zero hits in a huge, gitignore-less tree still returns
	// promptly instead of walking the entire filesystem underneath cwd.
	route("GET", "/api/sessions/:id/fs/search", (req, res, params) => {
		const sessionRoot = sessionCwd(params.id);
		if (!sessionRoot) return json(res, { error: "Not found" }, 404);
		const cwd = sessionRoot;
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
		if (!q) return json(res, { results: [] });

		const MAX_RESULTS = 200;
		const MAX_VISITED = 20_000;
		let visited = 0;
		const results: Array<{ path: string; type: "file" | "dir" }> = [];

		function walk(dir: string) {
			if (results.length >= MAX_RESULTS || visited >= MAX_VISITED) return;
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (results.length >= MAX_RESULTS || visited >= MAX_VISITED) return;
				if (e.name === ".git") continue;
				visited++;
				const full = join(dir, e.name);
				if (e.name.toLowerCase().includes(q)) {
					results.push({ path: relative(cwd, full), type: e.isDirectory() ? "dir" : "file" });
				}
				if (e.isDirectory()) walk(full);
			}
		}
		walk(cwd);
		json(res, { results, truncated: results.length >= MAX_RESULTS || visited >= MAX_VISITED });
	});

	// Extensions the preview modal can render directly in the browser (an
	// <img>/<iframe> pointed straight at this route) — everything else stays
	// application/octet-stream, which is fine for a plain download but would
	// make a PDF open as a blank/broken embed instead of rendering.
	const PREVIEW_MIME: Record<string, string> = {
		pdf: "application/pdf",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		bmp: "image/bmp",
		ico: "image/x-icon",
		svg: "image/svg+xml",
	};

	// Streams one file's raw bytes — the whole point being this works
	// regardless of git state (untracked, committed, no repo at all), unlike
	// the Changes panel above. Defaults to a download disposition; the
	// preview modal passes ?inline=1 to instead get a disposition (and, for
	// known types, a real Content-Type) a browser will render in place
	// rather than offering to save.
	route("GET", "/api/sessions/:id/fs/download", (req, res, params) => {
		const cwd = sessionCwd(params.id);
		if (!cwd) return json(res, { error: "Not found" }, 404);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const rel = url.searchParams.get("path") ?? "";
		const target = resolve(cwd, rel);
		if (!rel || target === cwd || !isInsideRoot(cwd, target)) return json(res, { error: "Invalid path" }, 400);
		try {
			const st = statSync(target);
			if (!st.isFile()) return json(res, { error: "Not a file" }, 400);
			const name = basename(target);
			const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
			const inline = url.searchParams.get("inline") === "1";
			res.writeHead(200, {
				"Content-Type": inline ? (PREVIEW_MIME[ext] ?? "application/octet-stream") : "application/octet-stream",
				"Content-Length": st.size,
				"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(FILENAME_QUOTE_RE, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			});
			createReadStream(target).pipe(res);
		} catch (err) {
			if (!res.headersSent) json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Recursive delete — a file or an entire folder. The client is expected to
	// have already confirmed with the user (a themed confirm dialog, worded
	// harder for a folder than a file); this route's only job is the same
	// path-containment check every other /fs/* route makes, refusing to ever
	// touch cwd itself or anything outside it.
	route("DELETE", "/api/sessions/:id/fs", (req, res, params) => {
		const cwd = sessionCwd(params.id);
		if (!cwd) return json(res, { error: "Not found" }, 404);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const rel = url.searchParams.get("path") ?? "";
		const target = resolve(cwd, rel);
		if (!rel || target === cwd || !isInsideRoot(cwd, target)) {
			return json(res, { error: "Refusing to delete this path" }, 400);
		}
		try {
			rmSync(target, { recursive: true, force: false });
			json(res, { ok: true });
		} catch (err) {
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Renames a file or folder in place (same parent directory) — the new
	// name only, never a path, same rule as the "new folder" name field
	// below: no separators, no "..", so this can never turn into a move.
	route("POST", "/api/sessions/:id/fs/rename", async (req, res, params) => {
		const cwd = sessionCwd(params.id);
		if (!cwd) return json(res, { error: "Not found" }, 404);
		let parsed: { path?: string; name?: string };
		try {
			parsed = JSON.parse(await readBody(req));
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const rel = parsed.path ?? "";
		const name = (parsed.name ?? "").trim();
		if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
			return json(res, { error: "Invalid name" }, 400);
		}
		const target = resolve(cwd, rel);
		if (!rel || target === cwd || !isInsideRoot(cwd, target)) {
			return json(res, { error: "Invalid path" }, 400);
		}
		const dest = join(dirname(target), name);
		if (!isInsideRoot(cwd, dest)) return json(res, { error: "Invalid destination" }, 400);
		try {
			renameSync(target, dest);
			json(res, { ok: true, path: relative(cwd, dest) });
		} catch (err) {
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Attached documents (see inputs.ts) — a flat, session-scoped directory
	// outside the project tree, so unlike /fs/* above there's no subdirectory
	// nesting to walk and no cwd-relative path resolution needed.
	route("GET", "/api/sessions/:id/inputs", (_req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		const dir = sessionInputsDir(params.id);
		try {
			const entries = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => {
					let size: number | undefined;
					try {
						size = statSync(join(dir, e.name)).size;
					} catch {
						size = undefined;
					}
					return { name: e.name, size };
				})
				.sort((a, b) => a.name.localeCompare(b.name));
			json(res, { entries });
		} catch (err) {
			// No attachments yet is the common case, not an error — same
			// reasoning as GET /fs's ENOENT handling for a not-yet-created
			// sandbox cwd.
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return json(res, { entries: [] });
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// 25MB — generous for a PDF/docx/small archive, small enough that a
	// mistaken multi-gigabyte drop doesn't fill the disk or hang the request
	// buffering the whole base64 body in memory (see readBody).
	const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024;

	route("POST", "/api/sessions/:id/inputs/upload", async (req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		let parsed: { name?: string; dataUrl?: string };
		try {
			parsed = JSON.parse(await readBody(req));
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		// basename() so a full path (or a client sending one by mistake/malice)
		// can't escape the flat inputs directory — same rule as download/delete.
		const name = basename((parsed.name ?? "").trim());
		if (!name || name === "." || name === "..") return json(res, { error: "Invalid file name" }, 400);
		if (isBlockedAttachmentName(name)) {
			return json(res, { error: `Executable/binary files aren't accepted as attachments: "${name}"` }, 400);
		}
		const dataUrl = parsed.dataUrl ?? "";
		const comma = dataUrl.indexOf(",");
		if (!dataUrl.startsWith("data:") || comma === -1) {
			return json(res, { error: "Expected a data: URL" }, 400);
		}
		let buf: Buffer;
		try {
			buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
		} catch {
			return json(res, { error: "Invalid base64 payload" }, 400);
		}
		if (buf.length > MAX_INPUT_FILE_BYTES) {
			return json(res, { error: `File too large — max ${MAX_INPUT_FILE_BYTES / (1024 * 1024)}MB` }, 400);
		}
		const dir = sessionInputsDir(params.id);
		mkdirSync(dir, { recursive: true });
		// Same name attached twice (re-upload, or two files that happen to
		// share a name) gets a " (2)", " (3)", ... suffix rather than silently
		// clobbering the first one — the model and the user both still have
		// distinct files to refer to instead of one overwriting the other.
		let finalName = name;
		if (existsSync(join(dir, finalName))) {
			const dot = name.lastIndexOf(".");
			const stem = dot === -1 ? name : name.slice(0, dot);
			const ext = dot === -1 ? "" : name.slice(dot);
			for (let n = 2; existsSync(join(dir, finalName)); n++) finalName = `${stem} (${n})${ext}`;
		}
		const target = join(dir, finalName);
		writeFileSync(target, buf);
		json(res, { ok: true, name: finalName, path: target, size: buf.length });
	});

	route("GET", "/api/sessions/:id/inputs/download", (req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		const dir = sessionInputsDir(params.id);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const name = url.searchParams.get("path") ?? "";
		// Flat directory — a filename is anything with no separator and no
		// "..", the same rule /fs/rename uses for its own "name" field. This
		// (not isInsideRoot) is the containment check here, since there's no
		// subdirectory structure for a relative path to escape in the first place.
		if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
			return json(res, { error: "Invalid path" }, 400);
		}
		const target = join(dir, name);
		try {
			const st = statSync(target);
			if (!st.isFile()) return json(res, { error: "Not a file" }, 400);
			const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
			const inline = url.searchParams.get("inline") === "1";
			res.writeHead(200, {
				"Content-Type": inline ? (PREVIEW_MIME[ext] ?? "application/octet-stream") : "application/octet-stream",
				"Content-Length": st.size,
				"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(FILENAME_QUOTE_RE, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			});
			createReadStream(target).pipe(res);
		} catch (err) {
			if (!res.headersSent) json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	route("DELETE", "/api/sessions/:id/inputs", (req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		const dir = sessionInputsDir(params.id);
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const name = url.searchParams.get("path") ?? "";
		if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
			return json(res, { error: "Refusing to delete this path" }, 400);
		}
		try {
			rmSync(join(dir, name), { force: false });
			json(res, { ok: true });
		} catch (err) {
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Read-only directory listing for the "new session" working-directory
	// picker — no narrower than what a session can already do with the bash
	// tool once it exists, so gating it behind the same Basic Auth as
	// everything else (rather than a separate allowed-root) is consistent
	// with the rest of this API's trust boundary.
	route("GET", "/api/browse", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const requested = url.searchParams.get("path");
		const target = resolve(requested || bridge.getConfig().cwd || homedir());
		try {
			const st = statSync(target);
			if (!st.isDirectory()) throw new Error("Not a directory");
			const entries = readdirSync(target, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => e.name)
				.sort((a, b) => a.localeCompare(b))
				.map((name) => ({ name, path: join(target, name) }));
			const parent = dirname(target) === target ? null : dirname(target);
			json(res, { path: target, parent, entries });
		} catch (err) {
			json(res, {
				path: target,
				parent: dirname(target) === target ? null : dirname(target),
				entries: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// Only the basename, never a path — "name" comes from a plain text input
	// in the picker, not a path the user is otherwise navigating, so there's
	// no legitimate reason for it to contain a separator or "..".
	route("POST", "/api/browse/mkdir", async (req, res) => {
		let parsed: { path?: string; name?: string };
		try {
			parsed = JSON.parse(await readBody(req));
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const name = (parsed.name ?? "").trim();
		if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
			return json(res, { error: "Invalid folder name" }, 400);
		}
		const parent = resolve(parsed.path || bridge.getConfig().cwd || homedir());
		const target = join(parent, name);
		try {
			mkdirSync(target);
			json(res, { ok: true, path: target });
		} catch (err) {
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	// Non-recursive on purpose — this is one click away in a folder-picker
	// modal, not a deliberate "rm -rf" the user typed out. An OS ENOTEMPTY
	// error is the safety net for a directory that still has something in it;
	// the client surfaces it as-is rather than silently escalating to -r.
	route("DELETE", "/api/browse", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const target = resolve(url.searchParams.get("path") ?? "");
		const home = homedir();
		if (!target || target === "/" || target === home) {
			return json(res, { error: "Refusing to delete this directory" }, 400);
		}
		try {
			rmdirSync(target);
			json(res, { ok: true });
		} catch (err) {
			json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	route("GET", "/api/config", (_req, res) => {
		json(res, bridge.getConfig());
	});

	route("GET", "/api/commands", (req, res) => {
		const sessionId = new URL(req.url ?? "", "http://localhost").searchParams.get("session") ?? undefined;
		json(res, bridge.getSlashCommands(sessionId));
	});

	route("GET", "/api/themes", (_req, res) => {
		json(res, bridge.getThemes());
	});

	route("GET", "/api/settings/appearance", (_req, res) => {
		const { showReasoning } = loadSettings();
		json(res, { showReasoning: showReasoning ?? false });
	});
	route("POST", "/api/settings/appearance", async (req, res) => {
		let parsed: { showReasoning?: unknown };
		try {
			parsed = JSON.parse(await readBody(req)) as { showReasoning?: unknown };
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (typeof parsed.showReasoning === "boolean") {
			updateSettings({ showReasoning: parsed.showReasoning });
		} else {
			return json(res, { error: "showReasoning must be a boolean" }, 400);
		}
		json(res, { ok: true });
	});

	route("GET", "/api/models", async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const provider = url.searchParams.get("provider") ?? undefined;
		json(res, await bridge.getModels(provider));
	});
	route("GET", "/api/models/cached", (_req, res) => {
		json(res, bridge.getCachedModels());
	});
	route("GET", "/api/skill-content", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const name = url.searchParams.get("name");
		if (!name) return json(res, { ok: false, error: "name required" }, 400);
		json(res, bridge.readSkillContent(name));
	});
	route("GET", "/api/persona-content", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const name = url.searchParams.get("name");
		if (!name) return json(res, { ok: false, error: "name required" }, 400);
		json(res, bridge.readPersonaContent(name));
	});
	route("GET", "/api/plugin-content", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const id = url.searchParams.get("id");
		if (!id) return json(res, { ok: false, error: "id required" }, 400);
		json(res, bridge.readPluginContent(id));
	});
	route("POST", "/api/ssh/key", async (req, res) => {
		let name: unknown;
		let key: unknown;
		try {
			({ name, key } = JSON.parse(await readBody(req)) as { name?: unknown; key?: unknown });
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!name || !key) return json(res, { ok: false, error: "name and key required" }, 400);
		if (typeof name !== "string" || typeof key !== "string") {
			return json(res, { error: "name and key must be strings" }, 400);
		}
		json(res, bridge.saveSshKey(name, key));
	});
	route("POST", "/api/ssh/add", async (req, res) => {
		let parsed: {
			name?: unknown;
			host?: unknown;
			username?: unknown;
			port?: unknown;
			keyPath?: unknown;
			password?: unknown;
		};
		try {
			parsed = JSON.parse(await readBody(req)) as typeof parsed;
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		const { name, host, username, port, keyPath, password } = parsed;
		if (!name || !host) return json(res, { ok: false, error: "name and host required" }, 400);
		const validPort =
			port === undefined || (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535);
		if (
			typeof name !== "string" ||
			typeof host !== "string" ||
			(username !== undefined && typeof username !== "string") ||
			!validPort ||
			(keyPath !== undefined && typeof keyPath !== "string") ||
			(password !== undefined && typeof password !== "string")
		) {
			return json(res, { error: "Invalid SSH host fields" }, 400);
		}
		json(
			res,
			bridge.addSshHost(
				name,
				host,
				username ?? undefined,
				typeof port === "number" ? port : undefined,
				keyPath ?? undefined,
				password ?? undefined,
			),
		);
	});
	route("POST", "/api/provider/verify", async (req, res) => {
		let url: unknown;
		let apiKey: unknown;
		try {
			({ url, apiKey } = JSON.parse(await readBody(req)) as { url?: unknown; apiKey?: unknown });
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!url || !apiKey) return json(res, { ok: false, error: "url and apiKey required" }, 400);
		if (typeof url !== "string" || typeof apiKey !== "string") {
			return json(res, { error: "url and apiKey must be strings" }, 400);
		}
		json(res, await bridge.verifyProvider(url, apiKey));
	});

	route("GET", "/api/sessions/:id/reasoning-options", (_req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		json(res, bridge.getReasoningOptionsForSession(params.id));
	});

	route("GET", "/api/settings/reasoning-options", (_req, res) => {
		json(res, bridge.getReasoningOptionsForSession(""));
	});

	route("GET", "/api/suggest", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const input = url.searchParams.get("q") ?? "";
		const sessionId = url.searchParams.get("session") ?? "";
		json(res, bridge.suggestCommand(sessionId, input));
	});

	// Public, unauthenticated read-only view of one shared thread. The token
	// itself (24 random bytes) is the only credential — anyone with the link
	// can read the conversation, no basic-auth prompt, matching a "share"
	// feature's whole point (send it to someone with no cast account).
	route("GET", "/api/shared/:token", (_req, res, params) => {
		const shared = bridge.getSharedSession(params.token);
		if (!shared) return json(res, { error: "Not found" }, 404);
		json(res, shared);
	});

	// Main request handler
	const server = createServer(async (req, res) => {
		setSecurityHeaders(req, res);
		const urlPath = req.url?.split("?")[0] ?? "/";
		const method = req.method ?? "GET";

		// Measure every /api/* request for the dashboard's system-performance
		// tab. The telemetry reads themselves and SSE event streams are excluded:
		// telemetry reads would pollute the data, and an SSE connection's
		// `finish` fires only when the client disconnects — its duration is the
		// session lifetime, not a request/response latency. One cheap prepared
		// INSERT on res.finish.
		if (urlPath.startsWith("/api/") && !urlPath.startsWith("/api/telemetry/") && !urlPath.endsWith("/events")) {
			const reqStart = Date.now();
			res.on("finish", () => {
				recordApiRequest({ method, path: urlPath, status: res.statusCode, latencyMs: Date.now() - reqStart });
			});
		}

		// /shared/<token> (the page) and /api/shared/<token> (its data) are the
		// one deliberate hole in auth — everything else still needs a session.
		// The static assets the shared page itself loads (app.js, stylesheets,
		// icons.js) have to be exempt too, or the browser 401s fetching them and
		// hangs on its native credentials prompt with nothing ever rendering —
		// they carry no secrets (the actual password check happens server-side
		// against every real /api/* route, which stays gated) so this doesn't
		// widen what an unauthenticated visitor can actually do.
		const PUBLIC_STATIC_ASSETS = new Set([
			"/app.js",
			"/new-session-modal.js",
			"/login.html",
			"/login.css",
			"/login.js",
			"/tokens.css",
			"/style.css",
			"/chat.css",
			"/tools.css",
			"/workspace.css",
			"/settings.css",
			"/icons.js",
			"/stream-blocks.js",
			"/favicon.svg",
			"/cast-banner-grid.json",
			// Vendored framework bits — they're imported by app.js before any
			// auth check fires, so they have to be reachable without a session,
			// same reason /app.js itself is. Lazy-only modules (highlight.js,
			// marked) stay auth-gated because they only load from inside
			// file-preview.js, which runs after sign-in.
			"/vendor/preact.mjs",
			"/vendor/preact-hooks.mjs",
			"/vendor/htm.mjs",
		]);
		const isPublicShareRoute =
			urlPath === "/login" ||
			urlPath === "/login.html" ||
			urlPath.startsWith("/api/auth/") ||
			urlPath === "/shared" ||
			urlPath.startsWith("/shared/") ||
			urlPath.startsWith("/api/shared/") ||
			urlPath === OPENAPI_V1_PATH ||
			PUBLIC_STATIC_ASSETS.has(urlPath) ||
			urlPath.startsWith("/fonts/");
		if (!isPublicShareRoute && !isAuthenticated(req)) {
			requireAuth(res, urlPath.startsWith("/api/"));
			return;
		}

		// An already-authenticated visitor landing on /login (after `api.js`
		// bounces them here on a 401, after a manual paste of /login, after a
		// bfcache restore of the page they had open while still signed in) gets
		// redirected straight to the SPA. Otherwise we'd serve login.html and
		// the user would see the auth form flash on screen until login.js's
		// own redirectIfAuthenticated finished its round-trip back to /.
		if (method === "GET" && (urlPath === "/login" || urlPath === "/login.html") && isAuthenticated(req)) {
			res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
			res.end();
			return;
		}

		if (method === "GET" && urlPath === "/login") {
			if (serveStatic({ url: "/login.html", headers: req.headers } as IncomingMessage, res)) return;
		}

		// The share page is a client-side route with no matching static file
		// (there's no shared.html — it's the same SPA, reading the token off
		// location.pathname) — serve index.html for it like any other deep link.
		if (method === "GET" && urlPath.startsWith("/shared/") && !urlPath.startsWith("/api/")) {
			if (serveStatic({ url: "/" } as IncomingMessage, res)) return;
		}

		const versionedLegacyPath = legacyPathForApiV1(urlPath);
		if (versionedLegacyPath) res.setHeader("Cast-API-Version", "1");
		if (versionedLegacyPath && !isStableApiV1Route(method, versionedLegacyPath) && urlPath !== OPENAPI_V1_PATH) {
			json(res, { error: "Unknown API v1 route" }, 404);
			return;
		}

		// Versioned integration routes reuse the same handlers as the legacy UI
		// surface, so behavior cannot drift while their URL/schema contract stays
		// independently stable.
		const matched = matchRoute(method, versionedLegacyPath ?? urlPath);
		if (matched) {
			try {
				await matched.handler(req, res, matched.params);
			} catch (err) {
				console.error(`[cast server] ${method} ${urlPath}:`, err);
				if (!res.headersSent) {
					json(res, { error: "Internal server error" }, 500);
				}
			}
			return;
		}

		// Static files (fallback)
		if (method === "GET") {
			if (serveStatic(req, res)) return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	});

	// A raw, unhandled "error" event on an http.Server crashes the process
	// with a stack trace — the common case being EADDRINUSE (another 'cast
	// web', or anything else, already on this port). Route it through
	// `onError` instead of exiting here directly, so the caller controls what
	// "failed to start" means for it (the CLI launcher prints a clear message
	// and exits; a test can assert on the error without killing the runner).
	server.on("error", (err: NodeJS.ErrnoException) => {
		options.onError?.(err);
	});

	server.listen(port, host, () => {
		const addr = server.address();
		const boundPort = addr && typeof addr === "object" ? addr.port : port;
		console.log(`[cast server] listening on http://${host}:${boundPort}`);
		options.onListening?.(boundPort);
	});

	return server;
}

// ── Diff parsing ──

interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: Array<{ type: "+" | "-" | " "; content: string }>;
}

interface DiffFile {
	path: string;
	oldPath?: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

interface FileGroups {
	untracked: string[];
	added: string[];
	modified: string[];
	deleted: string[];
	renamed: string[];
}

function emptyGroups(): FileGroups {
	return { untracked: [], added: [], modified: [], deleted: [], renamed: [] };
}

function parseDiff(raw: string): { files: DiffFile[] } {
	const files: DiffFile[] = [];
	let currentFile: DiffFile | null = null;
	let currentHunk: DiffHunk | null = null;

	for (const line of raw.split("\n")) {
		if (line.startsWith("diff --git")) {
			const match = DIFF_FILE_RE.exec(line);
			currentFile = {
				path: match?.[1] ?? "unknown",
				hunks: [],
				additions: 0,
				deletions: 0,
			};
			files.push(currentFile);
			currentHunk = null;
			continue;
		}

		if (!currentFile) continue;

		if (line.startsWith("--- a/")) {
			currentFile.oldPath = line.slice(6);
			continue;
		}
		if (line.startsWith("--- /dev/null")) {
			currentFile.oldPath = undefined;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---")) continue;

		const hunkMatch = HUNK_HEADER_RE.exec(line);
		if (hunkMatch) {
			currentHunk = {
				oldStart: parseInt(hunkMatch[1]!, 10),
				oldLines: parseInt(hunkMatch[2] ?? "1", 10),
				newStart: parseInt(hunkMatch[3]!, 10),
				newLines: parseInt(hunkMatch[4] ?? "1", 10),
				lines: [],
			};
			currentFile.hunks.push(currentHunk);
			continue;
		}

		if (!currentHunk) continue;

		if (line.startsWith("+")) {
			currentHunk.lines.push({ type: "+", content: line.slice(1) });
			currentFile.additions++;
		} else if (line.startsWith("-")) {
			currentHunk.lines.push({ type: "-", content: line.slice(1) });
			currentFile.deletions++;
		} else {
			currentHunk.lines.push({ type: " ", content: line.startsWith(" ") ? line.slice(1) : line });
		}
	}

	return { files };
}
