/**
 * Web server — node:http, static files, REST API, SSE, HTTP Basic Auth.
 * Zero npm dependencies. The browser's own credential prompt (and its
 * password manager) does the work — no bespoke login page or session cookie
 * to build and keep in sync with it.
 */

import { execSync } from "node:child_process";
import {
	createReadStream,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getHistoryPage } from "../core/session.ts";
import { toDisplayMessages, type WebBridge, type WebEvent } from "./bridge.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

export interface WebServerOptions {
	port: number;
	/** Interface to bind — the caller decides the default (127.0.0.1 vs 0.0.0.0), this just binds what it's given. */
	host: string;
	bridge: WebBridge;
	webUser: string;
	webPassword: string;
	version: string;
	/** Fires once the server is actually bound and accepting connections. */
	onListening?: () => void;
	/** Fires on a listen failure (e.g. EADDRINUSE) instead of the process crashing on an unhandled error event. */
	onError?: (err: NodeJS.ErrnoException) => void;
}

export function startWebServer(options: WebServerOptions): ReturnType<typeof createServer> {
	const { port, host, bridge, webUser, webPassword } = options;
	const publicDir = join(import.meta.dirname ?? ".", "public");

	console.log(`[cast web] auth enabled (user: ${webUser})`);

	function checkBasicAuth(req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		if (!header.startsWith("Basic ")) return false;
		let decoded: string;
		try {
			decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
		} catch {
			return false;
		}
		const sep = decoded.indexOf(":");
		if (sep === -1) return false;
		return decoded.slice(0, sep) === webUser && decoded.slice(sep + 1) === webPassword;
	}

	function requireAuth(res: ServerResponse): void {
		res.writeHead(401, {
			"WWW-Authenticate": 'Basic realm="cast web", charset="UTF-8"',
			"Content-Type": "text/plain",
		});
		res.end("Authentication required");
	}

	// Helpers
	function json(res: ServerResponse, data: unknown, status = 200): void {
		const body = JSON.stringify(data);
		res.writeHead(status, {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
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
			// index.html is never cached (below), but app.js/style.css are — so
			// stamp their URLs with the running version here. A browser holding
			// a stale cached index.html still asks for the JS/CSS it originally
			// linked, which is fine; any fresh load after an upgrade gets new
			// URLs and bypasses the old cache entry instead of racing it.
			const buildStamp = Date.now().toString(36);
			let content: Buffer | string = readFileSync(filePath);
			if (ext === ".html") {
				content = content
					.toString("utf-8")
					.replace('href="/style.css"', `href="/style.css?v=${buildStamp}"`)
					.replace('src="/app.js"', `src="/app.js?v=${buildStamp}"`);
			}
			res.writeHead(200, {
				"Content-Type": mime,
				"Content-Length": Buffer.byteLength(content),
				"Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
			});
			res.end(content);
			return true;
		} catch {
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
		const pattern = path.replace(/:(\w+)/g, (_match, name) => {
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
	route("GET", "/api/personas", (_req, res) => {
		json(res, bridge.getPersonas());
	});

	route("GET", "/api/sessions", (_req, res) => {
		json(res, bridge.listSessions());
	});

	route("POST", "/api/sessions", async (req, res) => {
		const body = await readBody(req);
		let persona: string | undefined;
		let model: string | undefined;
		let cwd: string | undefined;
		try {
			const parsed = JSON.parse(body) as { persona?: string; model?: string; cwd?: string };
			persona = parsed.persona;
			model = parsed.model;
			cwd = parsed.cwd;
		} catch {
			// empty body is fine
		}
		// Clients passing an explicit sandbox path (pre-SANDBOX_CWD-sentinel) still
		// get it created for them; the current "new" button sends the sentinel and
		// the bridge derives/creates the dir itself.
		if (cwd?.includes(".cast/sandbox/cast-")) {
			try {
				mkdirSync(cwd, { recursive: true });
			} catch {}
		}
		const ws = bridge.createSession(persona, model, cwd);
		json(res, { id: ws.id, session: ws.session }, 201);
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
		res.write(": connected\n\n");

		const listener = (event: WebEvent) => {
			try {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			} catch {
				bridge.unsubscribeAll(listener);
			}
		};
		bridge.subscribeAll(listener);

		const heartbeat = setInterval(() => {
			try {
				res.write(": keepalive\n\n");
			} catch {
				clearInterval(heartbeat);
				bridge.unsubscribeAll(listener);
			}
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			bridge.unsubscribeAll(listener);
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
		json(res, {
			id: ws.id,
			persona: ws.session.persona,
			model: ws.session.model,
			cwd: ws.session.cwd,
			mode: ws.session.mode ?? "build",
			title: ws.session.title,
			pinned: ws.session.pinned,
			shareToken: ws.session.shareToken ?? null,
			status: ws.status,
			messages: toDisplayMessages(page.messages, page.reasoning),
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
			messages: toDisplayMessages(page.messages, page.reasoning),
			oldestSeq: page.oldestSeq ?? null,
			hasMoreHistory: page.hasMore,
		});
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

	route("POST", "/api/sessions/:id/chat", async (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		const body = await readBody(req);
		let text: string;
		try {
			const parsed = JSON.parse(body) as { text?: string };
			text = parsed.text ?? "";
		} catch {
			return json(res, { error: "Invalid JSON" }, 400);
		}
		if (!text.trim()) return json(res, { error: "Empty message" }, 400);
		bridge.submit(params.id, text);
		json(res, { ok: true }, 202);
	});

	route("POST", "/api/sessions/:id/abort", (_req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);
		bridge.abort(params.id);
		json(res, { ok: true });
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

	route("GET", "/api/sessions/:id/events", (req, res, params) => {
		const ws = bridge.getSession(params.id);
		if (!ws) return json(res, { error: "Not found" }, 404);

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});

		// Send current status immediately
		res.write(`data: ${JSON.stringify({ type: "status", status: ws.status })}\n\n`);

		const listener = (event: WebEvent) => {
			try {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
				// The session is gone from the bridge's map by the time this fires —
				// nothing left to unsubscribe from, just end the stream so the
				// client's EventSource doesn't spend its retry budget on a 404.
				if (event.type === "session_closed") res.end();
			} catch {
				// Client disconnected
				bridge.unsubscribe(params.id, listener);
			}
		};
		bridge.subscribe(params.id, listener);

		// Heartbeat
		const heartbeat = setInterval(() => {
			try {
				res.write(": keepalive\n\n");
			} catch {
				clearInterval(heartbeat);
				bridge.unsubscribe(params.id, listener);
			}
		}, 15_000);

		req.on("close", () => {
			clearInterval(heartbeat);
			bridge.unsubscribe(params.id, listener);
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
				"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
	route("GET", "/api/plugin-content", (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const id = url.searchParams.get("id");
		if (!id) return json(res, { ok: false, error: "id required" }, 400);
		json(res, bridge.readPluginContent(id));
	});
	route("POST", "/api/ssh/key", async (req, res) => {
		const body = await readBody(req);
		const { name, key } = JSON.parse(body);
		if (!name || !key) return json(res, { ok: false, error: "name and key required" }, 400);
		json(res, bridge.saveSshKey(name, key));
	});
	route("POST", "/api/provider/verify", async (req, res) => {
		const body = await readBody(req);
		const { url, apiKey } = JSON.parse(body);
		if (!url || !apiKey) return json(res, { ok: false, error: "url and apiKey required" }, 400);
		json(res, await bridge.verifyProvider(url, apiKey));
	});

	route("GET", "/api/sessions/:id/reasoning-options", (_req, res, params) => {
		if (!bridge.getSession(params.id)) return json(res, { error: "Not found" }, 404);
		json(res, bridge.getReasoningOptionsForSession(params.id));
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
		const urlPath = req.url?.split("?")[0] ?? "/";
		const method = req.method ?? "GET";

		// /shared/<token> (the page) and /api/shared/<token> (its data) are the
		// one deliberate hole in auth — everything else still needs Basic Auth.
		// The static assets the shared page itself loads (app.js, style.css,
		// icons.js) have to be exempt too, or the browser 401s fetching them and
		// hangs on its native credentials prompt with nothing ever rendering —
		// they carry no secrets (the actual password check happens server-side
		// against every real /api/* route, which stays gated) so this doesn't
		// widen what an unauthenticated visitor can actually do.
		const PUBLIC_STATIC_ASSETS = new Set([
			"/app.js",
			"/style.css",
			"/icons.js",
			"/favicon.svg",
			"/cast-banner-grid.json",
		]);
		const isPublicShareRoute =
			urlPath === "/shared" ||
			urlPath.startsWith("/shared/") ||
			urlPath.startsWith("/api/shared/") ||
			PUBLIC_STATIC_ASSETS.has(urlPath);
		if (!isPublicShareRoute && !checkBasicAuth(req)) {
			requireAuth(res);
			return;
		}

		// The share page is a client-side route with no matching static file
		// (there's no shared.html — it's the same SPA, reading the token off
		// location.pathname) — serve index.html for it like any other deep link.
		if (method === "GET" && urlPath.startsWith("/shared/") && !urlPath.startsWith("/api/")) {
			if (serveStatic({ url: "/" } as IncomingMessage, res)) return;
		}

		// API routes
		const matched = matchRoute(method, urlPath);
		if (matched) {
			try {
				await matched.handler(req, res, matched.params);
			} catch (err) {
				console.error(`[cast web] ${method} ${urlPath}:`, err);
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
		console.log(`[cast web] listening on http://${host}:${port}`);
		options.onListening?.();
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
			const match = /b\/(.+)$/.exec(line);
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

		const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
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
