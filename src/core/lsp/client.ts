/**
 * One language server process, spoken to over stdio JSON-RPC (LSP base
 * protocol: `Content-Length` framed messages). Keeps what cast needs from it:
 * requests with a timeout, the diagnostics it publishes per file, and the
 * text-document sync that tells it what the agent changed on disk.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LspDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	/** 1 error, 2 warning, 3 information, 4 hint. */
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface LspClientOptions {
	serverId: string;
	command: string;
	args: string[];
	root: string;
	env?: Record<string, string>;
	initializationOptions?: unknown;
	/** Answers `workspace/configuration`; the server's own defaults when absent. */
	settings?: Record<string, unknown>;
	/** Called when the process exits on its own. */
	onExit?: (code: number | null) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const REJECT = Symbol("reject");
const CONTENT_LENGTH_RE = /content-length:\s*(\d+)/i;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Larger files aren't handed to a server: its index would be the whole file. */
export const MAX_DOCUMENT_BYTES = 4_000_000;
const SECRET_ENV_RE = /(API_?KEY|_TOKEN$|^TOKEN$|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;

/** The environment minus credentials: a language server has no use for the user's keys. */
function scrubbedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!SECRET_ENV_RE.test(key)) env[key] = value;
	return env;
}
const INITIALIZE_TIMEOUT_MS = 45_000;

/** Maps a file extension to the LSP languageId servers expect in didOpen. */
export function languageIdFor(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const ids: Record<string, string> = {
		ts: "typescript",
		mts: "typescript",
		cts: "typescript",
		tsx: "typescriptreact",
		js: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		jsx: "javascriptreact",
		py: "python",
		pyi: "python",
		go: "go",
		rs: "rust",
		c: "c",
		h: "c",
		cc: "cpp",
		cpp: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		java: "java",
		rb: "ruby",
		php: "php",
		cs: "csharp",
		kt: "kotlin",
		swift: "swift",
		lua: "lua",
		sh: "shellscript",
		bash: "shellscript",
		json: "json",
		css: "css",
		scss: "scss",
		html: "html",
		vue: "vue",
		svelte: "svelte",
		zig: "zig",
		ex: "elixir",
		exs: "elixir",
		dart: "dart",
		yaml: "yaml",
		yml: "yaml",
	};
	return ids[ext] ?? ext;
}

export function fileUri(path: string): string {
	return pathToFileURL(path).href;
}

export class LspClient {
	readonly serverId: string;
	readonly root: string;
	private readonly proc: ChildProcess;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly opened = new Map<string, { version: number; text: string }>();
	private readonly diagnostics = new Map<string, LspDiagnostic[]>();
	private readonly publishTimes = new Map<string, number>();
	private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
	private readonly settings: Record<string, unknown> | undefined;
	/** Pull-diagnostic registrations (`client/registerCapability`), by identifier. */
	private readonly pullIdentifiers = new Set<string | undefined>();
	private readonly registrationWaiters: Array<() => void> = [];
	private readonly registeredMethods = new Set<string>();
	private stderrTail = "";
	private exited = false;
	/** Last time the server was asked anything, for idle shutdown. */
	lastUsed = Date.now();
	/** What the server said it can do, from `initialize`. */
	capabilities: Record<string, unknown> = {};

	constructor(opts: LspClientOptions) {
		this.serverId = opts.serverId;
		this.root = opts.root;
		this.settings = opts.settings;
		this.proc = spawn(opts.command, opts.args, {
			cwd: opts.root,
			env: { ...scrubbedEnv(), ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group, so killing it takes the helpers it starts
			// (typescript-language-server's tsserver) along.
			detached: process.platform !== "win32",
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		// A server's stderr is its log; draining it keeps the pipe from filling.
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-4000);
		});
		this.proc.on("error", () => this.markExited(null));
		this.proc.on("exit", (code) => {
			this.markExited(code);
			opts.onExit?.(code);
		});
		this.proc.stdin?.on("error", () => {});
	}

	get alive(): boolean {
		return !this.exited;
	}

	/** The end of the server's log, for an error that says why it died. */
	get stderr(): string {
		return this.stderrTail.trim();
	}

	private markExited(_code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(`${this.serverId} exited`));
		}
		this.pending.clear();
		for (const [, waiters] of this.diagnosticWaiters) for (const wake of waiters) wake();
		this.diagnosticWaiters.clear();
	}

	private send(message: Record<string, unknown>): void {
		if (this.exited || !this.proc.stdin?.writable) return;
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf-8");
		this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = CONTENT_LENGTH_RE.exec(header);
			if (!match) {
				// Unframed noise before a header: drop it and resync on the next one.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (length > MAX_MESSAGE_BYTES) {
				// A runaway server would otherwise grow this buffer without bound.
				this.kill();
				return;
			}
			const start = headerEnd + 4;
			if (this.buffer.length < start + length) return;
			const body = this.buffer.subarray(start, start + length).toString("utf-8");
			this.buffer = this.buffer.subarray(start + length);
			try {
				this.onMessage(JSON.parse(body) as Record<string, unknown>);
			} catch {
				// A malformed message from the server: skip it, keep the stream.
			}
		}
	}

	private onMessage(msg: Record<string, unknown>): void {
		if (typeof msg.id === "number" && !("method" in msg)) {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.error) {
				const err = msg.error as { message?: string };
				pending.reject(new Error(err.message ?? "LSP request failed"));
			} else pending.resolve(msg.result);
			return;
		}
		const method = msg.method as string | undefined;
		if (!method) return;
		if ("id" in msg) {
			const result = this.answerServerRequest(method, msg.params);
			if (result === REJECT) {
				this.send({ id: msg.id, error: { code: -32601, message: `cast does not support ${method}` } });
			} else this.send({ id: msg.id, result });
			return;
		}
		if (method === "textDocument/publishDiagnostics") {
			const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
			this.storeDiagnostics(params.uri, params.diagnostics ?? []);
		}
	}

	private storeDiagnostics(uri: string, items: LspDiagnostic[]): void {
		this.diagnostics.set(uri, items);
		this.publishTimes.set(uri, Date.now());
		const waiters = this.diagnosticWaiters.get(uri);
		if (waiters) {
			this.diagnosticWaiters.delete(uri);
			for (const wake of waiters) wake();
		}
	}

	/** Requests the server makes of the client: answered so it never stalls on them. */
	private answerServerRequest(method: string, params: unknown): unknown | typeof REJECT {
		switch (method) {
			case "workspace/configuration": {
				const items = ((params as { items?: Array<{ section?: string }> })?.items ?? []).map((item) => {
					if (!this.settings) return null;
					if (!item.section) return this.settings;
					let node: unknown = this.settings;
					for (const part of item.section.split(".")) {
						node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
					}
					return node ?? null;
				});
				return items;
			}
			case "workspace/workspaceFolders":
				return [{ uri: fileUri(this.root), name: this.root }];
			case "client/registerCapability": {
				for (const reg of (
					params as { registrations?: Array<{ method: string; registerOptions?: { identifier?: string } }> }
				)?.registrations ?? []) {
					this.registeredMethods.add(reg.method);
					if (reg.method === "textDocument/diagnostic") this.pullIdentifiers.add(reg.registerOptions?.identifier);
				}
				for (const wake of this.registrationWaiters.splice(0)) wake();
				return null;
			}
			case "workspace/applyEdit":
				// Edits go through cast's own edit tool, where the user can see them.
				return REJECT;
			default:
				// window/workDoneProgress/create, client/unregisterCapability,
				// window/showMessageRequest and the rest: acknowledged.
				return null;
		}
	}

	request<T = unknown>(
		method: string,
		params: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.exited) return Promise.reject(new Error(`${this.serverId} is not running`));
		this.lastUsed = Date.now();
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const cancel = (why: string) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				this.notify("$/cancelRequest", { id });
				reject(new Error(why));
			};
			const timer = setTimeout(
				() => cancel(`${this.serverId}: ${method} timed out after ${timeoutMs}ms`),
				timeoutMs,
			);
			timer.unref();
			const onAbort = () => cancel("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				resolve: (v) => {
					signal?.removeEventListener("abort", onAbort);
					(resolve as (v: unknown) => void)(v);
				},
				reject: (e) => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
				timer,
			});
			this.send({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	async initialize(initializationOptions?: unknown): Promise<void> {
		const rootUri = fileUri(this.root);
		const result = await this.request<{ capabilities?: Record<string, unknown> }>(
			"initialize",
			{
				processId: process.pid,
				rootUri,
				rootPath: this.root,
				workspaceFolders: [{ uri: rootUri, name: this.root }],
				initializationOptions,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					workspace: {
						configuration: true,
						workspaceFolders: true,
						didChangeWatchedFiles: { dynamicRegistration: true },
					},
					window: { workDoneProgress: true },
					textDocument: {
						synchronization: { didSave: true, dynamicRegistration: true },
						publishDiagnostics: { relatedInformation: true, versionSupport: true },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: {},
						diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
					},
				},
			},
			INITIALIZE_TIMEOUT_MS,
		);
		this.capabilities = result?.capabilities ?? {};
		// Positions are UTF-16 code units on both sides; a server that insists on
		// another encoding would put every line:col slightly off.
		const encoding = this.capabilities.positionEncoding;
		if (typeof encoding === "string" && encoding !== "utf-16") {
			throw new Error(`uses ${encoding} positions; cast speaks utf-16`);
		}
		this.notify("initialized", {});
		if (this.settings) this.notify("workspace/didChangeConfiguration", { settings: this.settings });
	}

	/**
	 * Tells the server a file's current text: didOpen the first time, a full
	 * didChange after that. Clears the file's old diagnostics, so a later wait
	 * sees only what this version produced.
	 */
	syncFile(path: string): void {
		const uri = fileUri(path);
		let text: string;
		try {
			if (statSync(path).size > MAX_DOCUMENT_BYTES) return;
			text = readFileSync(path, "utf-8");
		} catch {
			return;
		}
		this.lastUsed = Date.now();
		const open = this.opened.get(uri);
		if (open === undefined) {
			this.diagnostics.delete(uri);
			this.opened.set(uri, { version: 0, text });
			this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 1 }] });
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: languageIdFor(path), version: 0, text },
			});
			return;
		}
		if (open.text === text) return;
		this.diagnostics.delete(uri);
		const version = open.version + 1;
		this.opened.set(uri, { version, text });
		this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 2 }] });
		// An incremental-only server takes one edit spanning the whole old text.
		const change = this.syncKind() === 2 ? { range: wholeRange(open.text), text } : { text };
		this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [change] });
		this.notify("textDocument/didSave", { textDocument: { uri }, text });
	}

	/** Tells the server a file is gone. */
	closeFile(path: string): void {
		const uri = fileUri(path);
		if (!this.opened.delete(uri)) return;
		this.diagnostics.delete(uri);
		this.notify("textDocument/didClose", { textDocument: { uri } });
		this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 3 }] });
	}

	private syncKind(): number {
		const sync = this.capabilities.textDocumentSync;
		if (typeof sync === "number") return sync;
		return (sync as { change?: number } | undefined)?.change ?? 1;
	}

	/** Whether the server offers a feature: declared at initialize, or registered since. */
	supports(capability: string, method: string): boolean {
		return Boolean(this.capabilities[capability]) || this.registeredMethods.has(method);
	}

	/** Whether the server answers `textDocument/diagnostic` (pull) rather than only publishing. */
	get supportsPull(): boolean {
		return Boolean(this.capabilities.diagnosticProvider) || this.pullIdentifiers.size > 0;
	}

	/**
	 * Asks a pull-diagnostics server for a file's diagnostics, under every
	 * identifier it registered, and stores what comes back like a publish.
	 */
	async pullDiagnostics(path: string, timeoutMs: number): Promise<void> {
		const uri = fileUri(path);
		const ids = new Set(this.pullIdentifiers);
		const staticId = (this.capabilities.diagnosticProvider as { identifier?: string } | undefined)?.identifier;
		if (this.capabilities.diagnosticProvider) ids.add(staticId);
		const reports = await Promise.all(
			[...ids].map((identifier) =>
				this.request<PullReport>(
					"textDocument/diagnostic",
					{ textDocument: { uri }, ...(identifier ? { identifier } : {}) },
					timeoutMs,
				).catch(() => undefined),
			),
		);
		const byUri = new Map<string, LspDiagnostic[]>();
		const add = (u: string, items: LspDiagnostic[] | undefined) => {
			if (items) byUri.set(u, [...(byUri.get(u) ?? []), ...items]);
		};
		for (const report of reports) {
			if (!report) continue;
			if (report.kind === "full") add(uri, report.items);
			for (const [u, related] of Object.entries(report.relatedDocuments ?? {})) {
				if (related.kind === "full") add(u, related.items);
			}
		}
		if (reports.some((r) => r?.kind === "full") && !byUri.has(uri)) byUri.set(uri, []);
		for (const [u, items] of byUri) this.storeDiagnostics(u, items);
	}

	/** Resolves when the server registers a capability, or after `timeoutMs`. */
	waitForRegistration(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				const at = this.registrationWaiters.indexOf(wake);
				if (at !== -1) this.registrationWaiters.splice(at, 1);
				resolve();
			};
			const timer = setTimeout(wake, timeoutMs);
			timer.unref();
			this.registrationWaiters.push(wake);
		});
	}

	/** Files this server has open, as paths. */
	openFiles(): string[] {
		return [...this.opened.keys()].filter((u) => u.startsWith("file:")).map((u) => fileURLToPath(u));
	}

	isOpen(path: string): boolean {
		return this.opened.has(fileUri(path));
	}

	diagnosticsFor(path: string): LspDiagnostic[] | undefined {
		return this.diagnostics.get(fileUri(path));
	}

	allDiagnostics(): Map<string, LspDiagnostic[]> {
		return this.diagnostics;
	}

	/** Resolves once the server publishes diagnostics for the file, or after `timeoutMs`. */
	waitForDiagnostics(path: string, timeoutMs: number): Promise<void> {
		const uri = fileUri(path);
		if (this.exited || this.diagnostics.has(uri)) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(done, timeoutMs);
			timer.unref();
			const list = this.diagnosticWaiters.get(uri) ?? [];
			list.push(done);
			this.diagnosticWaiters.set(uri, list);
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
		});
	}

	/** Immediate, for process exit, when there is no time to ask nicely. */
	kill(): void {
		if (this.exited) return;
		try {
			if (this.proc.pid && process.platform !== "win32") process.kill(-this.proc.pid, "SIGKILL");
			else this.proc.kill("SIGKILL");
		} catch {
			this.proc.kill("SIGKILL");
		}
	}

	/** Diagnostics published since `since` for the file, if any arrived. */
	publishedSince(path: string, since: number): boolean {
		return (this.publishTimes.get(fileUri(path)) ?? 0) >= since;
	}

	async shutdown(): Promise<void> {
		if (this.exited) return;
		try {
			await this.request("shutdown", null, 2_000);
			this.notify("exit", null);
		} catch {
			// Unresponsive: killed below.
		}
		setTimeout(() => this.kill(), 1_000).unref();
	}
}

interface PullReport {
	kind: "full" | "unchanged";
	items?: LspDiagnostic[];
	relatedDocuments?: Record<string, { kind: "full" | "unchanged"; items?: LspDiagnostic[] }>;
}

function wholeRange(text: string): LspDiagnostic["range"] {
	const lines = text.split("\n");
	return { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } };
}
