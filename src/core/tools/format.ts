/**
 * Runs the project's own formatter on a file the agent just wrote or edited,
 * the way the project's editor would on save. Only a formatter the project
 * has configured and installed is used: a local node_modules binary for
 * biome/prettier (never an npx download), ruff or gofmt from PATH.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";

const FORMAT_TIMEOUT_MS = 10_000;

const JS_LIKE = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css"]);
const PRETTIER_EXTRA = new Set([".scss", ".less", ".md", ".mdx", ".html", ".vue", ".yaml", ".yml", ".graphql"]);
const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.json5",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	".prettierrc.toml",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
	"prettier.config.ts",
];

export interface Formatter {
	name: string;
	command: string;
	args: string[];
	cwd: string;
}

function onPath(bin: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, bin))) return join(dir, bin);
	}
	return undefined;
}

function hasPrettierKey(dir: string): boolean {
	try {
		return "prettier" in JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
	} catch {
		return false;
	}
}

function hasRuffConfig(dir: string): boolean {
	if (existsSync(join(dir, "ruff.toml")) || existsSync(join(dir, ".ruff.toml"))) return true;
	try {
		return readFileSync(join(dir, "pyproject.toml"), "utf-8").includes("[tool.ruff");
	} catch {
		return false;
	}
}

/** The nearest configured formatter for this file, walking up from its directory. */
export function detectFormatter(filePath: string): Formatter | undefined {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".go") {
		const gofmt = onPath("gofmt");
		return gofmt ? { name: "gofmt", command: gofmt, args: ["-w", filePath], cwd: dirname(filePath) } : undefined;
	}
	for (let dir = dirname(filePath); ; dir = dirname(dir)) {
		const bin = (name: string) => {
			const path = join(dir, "node_modules", ".bin", name);
			return existsSync(path) ? path : undefined;
		};
		if (JS_LIKE.has(ext) && (existsSync(join(dir, "biome.json")) || existsSync(join(dir, "biome.jsonc")))) {
			const biome = bin("biome");
			if (biome) return { name: "biome", command: biome, args: ["format", "--write", filePath], cwd: dir };
		}
		if (
			(JS_LIKE.has(ext) || PRETTIER_EXTRA.has(ext)) &&
			(PRETTIER_CONFIGS.some((name) => existsSync(join(dir, name))) || hasPrettierKey(dir))
		) {
			const prettier = bin("prettier");
			if (prettier) return { name: "prettier", command: prettier, args: ["--write", filePath], cwd: dir };
		}
		if ((ext === ".py" || ext === ".pyi") && hasRuffConfig(dir)) {
			const venv = join(dir, ".venv", "bin", "ruff");
			const ruff = existsSync(venv) ? venv : onPath("ruff");
			if (ruff) return { name: "ruff", command: ruff, args: ["format", filePath], cwd: dir };
		}
		// A repository root ends the search: a formatter above it is someone
		// else's project.
		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return undefined;
	}
}

/**
 * Formats the file and says so when its content changed, so the model knows
 * its copy is stale before the next edit. A formatter that fails (a syntax
 * error it can't parse, a broken install) leaves the file as written.
 */
export async function formatWrittenFile(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
	const formatter = detectFormatter(filePath);
	if (!formatter) return undefined;
	let before: string;
	try {
		before = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	const ok = await new Promise<boolean>((resolve) => {
		execFile(formatter.command, formatter.args, { cwd: formatter.cwd, timeout: FORMAT_TIMEOUT_MS, signal }, (err) =>
			resolve(!err),
		);
	});
	if (!ok) return undefined;
	let after: string;
	try {
		after = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	if (after === before) return undefined;
	return `Auto-formatted with the project's formatter (${formatter.name}), as expected after every write and edit. The file now differs from what you wrote: read it before editing it again.`;
}
