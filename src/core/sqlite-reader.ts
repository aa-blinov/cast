/**
 * Read-only queries against the session store on a worker thread.
 *
 * node:sqlite is synchronous, and the daemon serves every session from one
 * thread: a full-text search over a 370MB store took 80 to 280ms, all of it
 * with every session, SSE stream and HTTP request stalled. A worker with its
 * own read-only connection keeps the main thread free; WAL lets it read while
 * the main connection writes.
 *
 * The worker is a string, not a file: the CLI ships as one bundled
 * dist/index.js, and a separate worker file would need its own build entry
 * and a path that is right both in the bundle and in a source checkout.
 */

import { Worker } from "node:worker_threads";

const QUERY_TIMEOUT_MS = 30_000;

// process.emitWarning is silenced first: node:sqlite prints its "experimental"
// notice once per thread, which would land in the middle of the TUI.
const WORKER_SOURCE = `
process.emitWarning = () => {};
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db = null;
let openPath = null;
parentPort.on("message", ({ id, path, sql, params }) => {
	try {
		if (openPath !== path) {
			if (db) db.close();
			db = new DatabaseSync(path, { readOnly: true });
			db.exec("PRAGMA busy_timeout = 5000");
			openPath = path;
		}
		parentPort.postMessage({ id, rows: db.prepare(sql).all(...params) });
	} catch (error) {
		parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
`;

interface Pending {
	resolve: (rows: unknown[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(error: Error): void {
	for (const [id, entry] of pending) {
		clearTimeout(entry.timer);
		entry.reject(error);
		pending.delete(id);
	}
}

function ensureWorker(): Worker {
	if (worker) return worker;
	const created = new Worker(WORKER_SOURCE, { eval: true });
	// A idle worker must not keep the CLI alive after everything else is done.
	created.unref();
	created.on("message", (message: { id: number; rows?: unknown[]; error?: string }) => {
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error !== undefined) entry.reject(new Error(message.error));
		else entry.resolve(message.rows ?? []);
	});
	const drop = (error: Error) => {
		if (worker === created) worker = null;
		failAll(error);
	};
	created.on("error", drop);
	created.on("exit", () => drop(new Error("sqlite reader stopped")));
	worker = created;
	return created;
}

/** Runs a SELECT on the store at `path`; the parameters must be structured-cloneable. */
export function queryReadOnly(path: string, sql: string, params: (string | number)[]): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		const current = ensureWorker();
		// unref'd: a query in flight is what keeps the process alive while it waits.
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("sqlite reader timed out"));
			// The worker is still busy with the query; a fresh one answers the next.
			if (worker === current) worker = null;
			void current.terminate();
		}, QUERY_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer });
		current.postMessage({ id, path, sql, params });
	});
}

/** Stops the worker; tests call this so a run does not leave a thread behind. */
export async function stopSqliteReader(): Promise<void> {
	const current = worker;
	worker = null;
	failAll(new Error("sqlite reader stopped"));
	if (current) await current.terminate();
}
