/**
 * Bash safety gate — a curated denylist of destructive/high-blast-radius
 * command patterns. Not exhaustive (no static check can be); it just catches
 * the obvious foot-guns. Without rules of the user's own (below), everything
 * else runs without asking, and write/edit are not gated: the file tools are
 * trivially reversible via git; an arbitrary shell command isn't.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { updateSettings } from "./settings.ts";
import { resolvePath } from "./tools/shared.ts";

interface DangerPattern {
	regex: RegExp;
	reason: string;
}

/**
 * Matches `word` only where a shell would actually treat it as a command
 * name (start of the string, or right after `;`, `&&`, `||`, `|`, or `(`) —
 * not word-boundary-anywhere, which would also match e.g. "sudo" inside
 * "hi-from-sudo" (hyphens count as word boundaries too).
 */
function commandStart(word: string): RegExp {
	return new RegExp(`(^|[;&|(]\\s*)${word}\\b`);
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
	{ regex: /\brm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)\b/, reason: "recursive/force delete (rm -rf)" },
	{ regex: commandStart("sudo"), reason: "elevated privileges (sudo)" },
	{ regex: /\bgit\s+push\b[^|;&\n]*(--force(?!-)\b|-f\b)/, reason: "force push (rewrites remote history)" },
	{ regex: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard (discards local changes)" },
	{ regex: /\bgit\s+clean\s+-\w*[df]\w*[df]?\w*/, reason: "git clean -fd (deletes untracked files)" },
	{
		regex: /\b(curl|wget)\b[^|;\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
		reason: "piping a remote script straight into a shell",
	},
	{ regex: /\bchmod\s+(-R\s+)?0?777\b/, reason: "chmod 777 (world-writable permissions)" },
	{ regex: commandStart("mkfs(\\.\\w+)?"), reason: "formatting a filesystem (mkfs)" },
	{ regex: /\bdd\s+if=/, reason: "raw disk write (dd)" },
	{ regex: />\s*\/dev\/(sd|nvme|disk|hd)/, reason: "writing directly to a block device" },
	{ regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
	{ regex: commandStart("(shutdown|reboot|poweroff|halt)"), reason: "shutting down or rebooting the machine" },
	// `--dry-run` publishes nothing — it is the command a release checklist
	// tells you to run *before* the real one, so asking to confirm it trains
	// the habit of confirming without reading.
	{ regex: /\bnpm\s+publish\b(?![^|;&\n]*--dry-run\b)/, reason: "publishing a package publicly" },
	{ regex: commandStart("killall"), reason: "killing every process on the machine" },
	{ regex: /\bkill\s+-9\s+-?1\b/, reason: "killing every process on the machine" },
	{ regex: /\bgit\s+(checkout|restore)\s+\.(?!\w)/, reason: "discarding all uncommitted changes" },
	{ regex: /\brsync\b[^|;&\n]*--delete/, reason: "rsync --delete (removes files not in source)" },
	{ regex: /\bfind\b[^|;&\n]*-delete/, reason: "find -delete (mass file deletion)" },
	{ regex: /\bxargs\b[^|;&\n]*\brm\b/, reason: "xargs rm (mass deletion via pipe)" },
	{ regex: commandStart("pkill"), reason: "killing processes by name" },
	{ regex: /\bcrontab\s+-r\b/, reason: "removing all cron jobs" },
	{ regex: /\biptables\s+-F\b/, reason: "flushing all firewall rules" },
	{
		regex: /\bb?base64\b[^|;&\n]*-d[^|;&\n]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/,
		reason: "decoding and piping into a shell (obfuscated code execution)",
	},
];

/** Returns a human-readable reason if `command` matches a known-dangerous pattern, else undefined. */
export function checkDangerousBash(command: string): string | undefined {
	for (const { regex, reason } of DANGEROUS_PATTERNS) {
		if (regex.test(command)) return reason;
	}
	return undefined;
}

/**
 * Permission rules from settings (`permissions.allow` / `ask` / `deny`), each
 * `tool` or `tool(pattern)`: `bash(git push*)`, `write(src/**)`, `mcp_github_*`.
 * Deny beats approved beats ask beats allow, whatever the order in the file,
 * so a broad allow can't quietly override a deny. `approved` holds the user's
 * "always allow" answers: it outranks `ask`, or the rule that asked would ask
 * again forever. The pattern is matched against the call's
 * subject: the command for bash/ssh, the path for the file tools, the URL for
 * web_fetch. A rule with a pattern never matches a tool that has no subject.
 */
export interface PermissionRules {
	allow?: string[];
	approved?: string[];
	ask?: string[];
	deny?: string[];
}

export type PermissionVerdict = { action: "allow" | "ask" | "deny"; rule: string };

const PATH_ARG: Record<string, string> = {
	read: "path",
	write: "path",
	edit: "filePath",
	ls: "path",
	glob: "path",
	grep: "path",
	lsp: "file_path",
};

/** What a rule's pattern is matched against for this call, if anything. */
export function permissionSubject(tool: string, args: Record<string, unknown>, cwd: string): string | undefined {
	if (tool === EXTERNAL_DIRECTORY) return typeof args.path === "string" ? args.path : undefined;
	const value =
		tool === "bash" || tool === "ssh"
			? args.command
			: tool === "web_fetch"
				? args.url
				: PATH_ARG[tool]
					? args[PATH_ARG[tool]]
					: undefined;
	if (typeof value !== "string") return undefined;
	if (!PATH_ARG[tool]) return value;
	// Paths as written in rules: relative to the project when inside it.
	const absolute = resolvePath(value, cwd);
	const rel = relative(cwd, absolute);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : absolute;
}

function globToRegex(glob: string, separator: "/" | undefined): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*" && glob[i + 1] === "*") {
			out += ".*";
			i++;
		} else if (ch === "*") out += separator ? "[^/]*" : ".*";
		else if (ch === "?") out += ".";
		else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "s");
}

function ruleMatches(rule: string, tool: string, subject: string | undefined, pathLike: boolean): boolean {
	const open = rule.indexOf("(");
	const name = (open < 0 ? rule : rule.slice(0, open)).trim();
	if (!globToRegex(name, undefined).test(tool)) return false;
	if (open < 0) return true;
	if (subject === undefined || !rule.endsWith(")")) return false;
	let pattern = rule.slice(open + 1, -1);
	if (pathLike && (pattern === "~" || pattern.startsWith("~/"))) pattern = homedir() + pattern.slice(1);
	return globToRegex(pattern, pathLike ? "/" : undefined).test(subject);
}

export function evaluatePermission(
	rules: PermissionRules | undefined,
	tool: string,
	args: Record<string, unknown>,
	cwd: string,
): PermissionVerdict | undefined {
	if (!rules) return undefined;
	const subject = permissionSubject(tool, args, cwd);
	const pathLike = tool in PATH_ARG || tool === EXTERNAL_DIRECTORY;
	for (const list of ["deny", "approved", "ask", "allow"] as const) {
		const entries = rules[list];
		if (!Array.isArray(entries)) continue;
		const rule = entries.find((r) => typeof r === "string" && ruleMatches(r, tool, subject, pathLike));
		if (rule) return { action: list === "approved" ? "allow" : list, rule };
	}
	return undefined;
}

/** The rule "always allow" saves for this call. `*` or `?` in the subject
 *  become single-character wildcards, so the rule can't widen past it. */
export function exactRule(tool: string, args: Record<string, unknown>, cwd: string): string {
	const subject = permissionSubject(tool, args, cwd);
	return subject === undefined ? tool : `${tool}(${subject.replace(/[*?]/g, "?")})`;
}

/** Saves an "always allow" answer to `permissions.approved`. */
export function addAllowRule(rule: string): void {
	updateSettings((current) => {
		const approved = current.permissions?.approved ?? [];
		return approved.includes(rule) ? {} : { permissions: { ...current.permissions, approved: [...approved, rule] } };
	});
}

/**
 * The file tools stay inside the project unless the user says otherwise: a
 * path outside it is checked against `external_directory(<glob>)` rules, and
 * asked about when none matches — reading `~/.ssh` or writing `/etc` is not
 * something to find out about afterwards. Inside means the session's cwd or
 * its project root (a worktree's own checkout counts). Reads may also reach
 * what cast itself hands the agent: saved tool output, uploaded inputs, and
 * the loaded skills' own files. `writableDirs` are cast's own working files
 * the agent is told to read and update (its memory), open to every tool.
 */
export const EXTERNAL_DIRECTORY = "external_directory";

const READ_TOOLS = new Set(["read", "ls", "glob", "grep", "lsp"]);
const DIRECTORY_TOOLS = new Set(["ls", "glob", "grep"]);

/** Follows symlinks where the path exists, so a link in the project can't lead out unseen. */
function realPath(path: string): string {
	try {
		if (existsSync(path)) return realpathSync(path);
		const parent = dirname(path);
		return parent === path ? path : join(realPath(parent), basename(path));
	} catch {
		return path;
	}
}

function within(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ExternalTarget {
	/** The resolved path the call reaches. */
	path: string;
	/** The directory an "always allow" covers. */
	dir: string;
}

export function externalTarget(
	tool: string,
	args: Record<string, unknown>,
	cwd: string,
	projectRoot: string,
	readableDirs: string[] = [],
	writableDirs: string[] = [],
): ExternalTarget | undefined {
	const key = PATH_ARG[tool];
	const value = key ? args[key] : undefined;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const path = realPath(resolvePath(value, cwd));
	if ([cwd, projectRoot, ...writableDirs].some((dir) => within(path, realPath(dir)))) return undefined;
	if (READ_TOOLS.has(tool) && readableDirs.some((dir) => within(path, realPath(dir)))) return undefined;
	return { path, dir: DIRECTORY_TOOLS.has(tool) ? path : dirname(path) };
}
