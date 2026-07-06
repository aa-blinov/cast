/**
 * Project context files (AGENTS.md, CLAUDE.md) — convention-based instruction
 * files that live in a repository root or any ancestor directory. Loaded and
 * injected into the system prompt so the model sees project-specific rules
 * without the user having to create a skill for them.
 *
 * Mirrors pi's loadProjectContextFiles (packages/coding-agent/src/core/resource-
 * loader.ts): searches for AGENTS.md / CLAUDE.md in cwd and every ancestor
 * directory up to the filesystem root, plus the global config dir. Files are
 * ordered root-first so that broad organizational guidelines come before
 * project-specific ones (the same ordering pi uses via unshift).
 *
 * Trust model: files from ~/.cast/ and ancestors above cwd load without
 * a trust check (the user placed those themselves). The file in cwd itself
 * is project-local and gated behind the unified project trust decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface ContextFile {
	path: string;
	content: string;
}

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadContextFileFromDir(dir: string): ContextFile | null {
	for (const filename of CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				if (content.trim()) return { path: filePath, content };
			} catch {
				// Unreadable file is silently skipped — same as pi.
			}
		}
	}
	return null;
}

/** Check whether a directory contains any context file candidate. */
export function hasContextFileInDir(dir: string): boolean {
	return loadContextFileFromDir(dir) !== null;
}

/**
 * Collect context files from ~/.cast/ and every ancestor of `cwd` up to
 * `/`. The file in cwd itself is only included when `projectTrusted` is true.
 * Returned root-first so higher-level guidelines precede project-specific ones.
 */
export function loadProjectContextFiles(cwd: string, projectTrusted: boolean): ContextFile[] {
	const resolvedCwd = resolve(cwd);
	const result: ContextFile[] = [];
	const seen = new Set<string>();

	const globalDir = join(process.env.HOME ?? ".", ".cast");
	const globalFile = loadContextFileFromDir(globalDir);
	if (globalFile) {
		result.push(globalFile);
		seen.add(globalFile.path);
	}

	// Walk ancestors from cwd to root. cwd itself is project-local (trust-gated);
	// everything above is the user's own filesystem hierarchy.
	const ancestorFiles: ContextFile[] = [];
	let current = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const file = loadContextFileFromDir(current);
		if (file && !seen.has(file.path)) {
			if (current !== resolvedCwd || projectTrusted) {
				ancestorFiles.unshift(file);
				seen.add(file.path);
			}
		}
		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	result.push(...ancestorFiles);
	return result;
}

/**
 * Nested AGENTS.md/CLAUDE.md that apply to files the agent has touched this
 * session. For each context file, walk up from its directory toward `cwd` and
 * collect any instruction file found *strictly below* cwd — the cwd file and
 * everything above it already load as the static base (loadProjectContextFiles),
 * so this only adds the per-subtree ones. This is opencode's per-file
 * `resolve()` model (walk up from the edited file, attach nearby AGENTS.md),
 * driven by the loop's accumulated contextFiles instead of a single filepath.
 *
 * `contextFiles` are paths from read/write/edit tool calls, relative to cwd
 * (absolute paths outside cwd are ignored). Deduped by path, ordered shallow
 * (broad) → deep (specific) so the nearest-to-the-file instructions read last.
 */
export function resolveNestedContextFiles(cwd: string, contextFiles: string[]): ContextFile[] {
	const resolvedCwd = resolve(cwd);
	const prefix = resolvedCwd + sep;
	const out: ContextFile[] = [];
	const seenFiles = new Set<string>();
	const seenDirs = new Set<string>();

	for (const rel of contextFiles) {
		const abs = resolve(resolvedCwd, rel);
		let dir = dirname(abs);
		// Only directories strictly below cwd; stop at cwd (base covers it).
		while (dir !== resolvedCwd && dir.startsWith(prefix)) {
			if (!seenDirs.has(dir)) {
				seenDirs.add(dir);
				const file = loadContextFileFromDir(dir);
				if (file && !seenFiles.has(file.path)) {
					seenFiles.add(file.path);
					out.push(file);
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	out.sort((a, b) => a.path.split(sep).length - b.path.split(sep).length);
	return out;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Format context files into a system prompt section. Returns an empty string
 * when there are no files.
 */
export function formatContextFilesForPrompt(files: ContextFile[]): string {
	if (files.length === 0) return "";

	const lines = ["", "", "<project_context>", "", "Project-specific instructions and guidelines:", ""];
	for (const file of files) {
		lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
		lines.push(file.content);
		lines.push("</project_instructions>", "");
	}
	lines.push("</project_context>");
	return lines.join("\n");
}
