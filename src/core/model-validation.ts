/**
 * Which (provider, key, model) passed the start-up check recently. That check
 * is a real completion ("Say exactly: ok"): on every TUI start it cost a paid
 * request and, on a slow provider, seconds before the composer. Passing once
 * a day is enough; a request that later fails on the key or the model forgets
 * the entry, so the next start checks again.
 *
 * Stored as a hash of the three, never the key itself.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MODEL_VALIDATION_TTL_MS = 24 * 60 * 60 * 1000;

interface Connection {
	baseURL: string;
	apiKey: string;
}

function file(): string {
	return join(homedir(), ".cast", "cache", "validated-models.json");
}

function key(connection: Connection, model: string): string {
	return createHash("sha256")
		.update(`${connection.baseURL}\u0000${connection.apiKey}\u0000${model}`)
		.digest("hex")
		.slice(0, 32);
}

function read(): Record<string, number> {
	try {
		const parsed = JSON.parse(readFileSync(file(), "utf-8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
	} catch {
		return {};
	}
}

function write(entries: Record<string, number>): void {
	try {
		mkdirSync(dirname(file()), { recursive: true });
		writeFileSync(file(), `${JSON.stringify(entries)}\n`);
	} catch {
		// A cache: without it the next start just checks again.
	}
}

export function recentlyValidated(connection: Connection, model: string, now = Date.now()): boolean {
	const at = read()[key(connection, model)];
	return typeof at === "number" && now - at < MODEL_VALIDATION_TTL_MS && at <= now;
}

export function rememberValidated(connection: Connection, model: string, now = Date.now()): void {
	const entries = read();
	for (const [k, at] of Object.entries(entries)) if (now - at >= MODEL_VALIDATION_TTL_MS) delete entries[k];
	entries[key(connection, model)] = now;
	write(entries);
}

export function forgetValidated(connection: Connection, model: string): void {
	const entries = read();
	const k = key(connection, model);
	if (!(k in entries)) return;
	delete entries[k];
	write(entries);
}
