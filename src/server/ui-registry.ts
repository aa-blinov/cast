/**
 * Pluggable UI registry — lets different frontends reuse the same cast daemon.
 * A UI is just a static directory with an index.html. Built-in UI lives at
 * src/server/public (=> dist/public after build). Extra UIs can be dropped
 * into:
 *   ~/.cast/ui/<name>/
 *   ./.cast/ui/<name>/   (project-local, trust-gated)
 *   ~/.config/cast/ui/<name>/
 * Each is served at /ui/<name>/ and listed at GET /api/uis.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UiEntry {
	name: string;
	dir: string;
	builtin: boolean;
}

function isUiDir(dir: string): boolean {
	try {
		return existsSync(join(dir, "index.html")) && statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function scanUisIn(root: string): UiEntry[] {
	const entries: UiEntry[] = [];
	let children: string[];
	try {
		children = readdirSync(root);
	} catch {
		return entries;
	}
	for (const name of children) {
		if (name.startsWith(".")) continue;
		const dir = join(root, name);
		if (isUiDir(dir)) entries.push({ name, dir, builtin: false });
	}
	return entries;
}

export function discoverUis(projectCwd: string, trusted: boolean): UiEntry[] {
	const builtinDir = join(import.meta.dirname ?? ".", "public");
	const uis: Map<string, UiEntry> = new Map();

	// Built-in always first, name "default"
	uis.set("default", { name: "default", dir: builtinDir, builtin: true });

	// Global: ~/.cast/ui/*
	for (const e of scanUisIn(join(homedir(), ".cast", "ui"))) {
		if (!uis.has(e.name)) uis.set(e.name, e);
	}
	// XDG global
	for (const e of scanUisIn(join(homedir(), ".config", "cast", "ui"))) {
		if (!uis.has(e.name)) uis.set(e.name, e);
	}
	// Project-local — trust-gated (same as skills/mcp)
	if (trusted) {
		for (const e of scanUisIn(join(projectCwd, ".cast", "ui"))) {
			if (!uis.has(e.name)) uis.set(e.name, e);
		}
		for (const e of scanUisIn(join(projectCwd, ".agents", "ui"))) {
			if (!uis.has(e.name)) uis.set(e.name, e);
		}
	}
	return [...uis.values()];
}

export function resolveUi(uis: UiEntry[], name: string): UiEntry | undefined {
	return uis.find((u) => u.name === name);
}
