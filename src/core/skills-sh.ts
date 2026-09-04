/**
 * skills.sh (`npx skills`) integration — install, remove, search, and list a
 * repository's skills from inside cast.
 *
 * skills.sh installs into the universal Agent Skills paths cast already
 * discovers (`~/.agents/skills`, and a project's `.agents/skills`), so a skill
 * installed here is immediately visible to cast and to every other agent on
 * the machine. This module holds the parts that are not UI: argument
 * normalization and the subprocess call, shared by the TUI's `/skills-sh` and
 * the web bridge's (which used to own the only copy).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { stripAnsi } from "./tools/bash.ts";

const execFileAsync = promisify(execFile);

const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\//i;
const GITHUB_GIT_SUFFIX = /\.git$/;
const WHITESPACE_SPLIT = /\s+/;

export const SKILLS_SH_INSTALL_TIMEOUT_MS = 120_000;
export const SKILLS_SH_QUERY_TIMEOUT_MS = 60_000;
export const SKILLS_SH_REMOVE_TIMEOUT_MS = 30_000;

/**
 * Turn whatever the user pasted into arguments `skills add` accepts.
 *
 * Handles three real-world shapes:
 * - The site's copy button gives a whole `npx skills add <pkg> --skill <name>`
 *   line, not just its tail — the `npx [--yes] skills add` prefix is dropped.
 * - The package may arrive as `https://github.com/<owner>/<repo>[.git]`, which
 *   `npx skills add` accepts but the CLI invocation here does not; it is
 *   reduced to `owner/repo`.
 * - `-a`/`--agent <name>` installs into that one agent's directory (e.g.
 *   `.claude/skills`) and never into the universal tree cast scans, so an
 *   `-a claude-code` install would silently never appear. It is dropped and
 *   `-g` forced, which installs the universal copy and symlinks it into every
 *   agent directory the CLI detects — nothing is lost either way.
 */
export function normalizeSkillsShInstallArgs(input: string): string[] {
	const args = input.trim() ? input.trim().split(WHITESPACE_SPLIT) : [];
	if (args[0] && GITHUB_URL_RE.test(args[0])) {
		args[0] = args[0].replace(GITHUB_URL_RE, "").replace(GITHUB_GIT_SUFFIX, "");
	}
	if (args[0] === "npx") args.shift();
	if (args[0] === "--yes" || args[0] === "-y") args.shift();
	if (args[0] === "skills") args.shift();
	if (args[0] === "add" || args[0] === "a") args.shift();

	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-a" || arg === "--agent") {
			i++; // its value goes too
			continue;
		}
		if (arg !== "-g" && arg !== "--global") out.push(arg!);
	}
	if (out.length === 0) return [];
	out.push("-g");
	return out;
}

/**
 * Run `npx skills <args>`, returning its combined output.
 *
 * `npx skills add` is a TTY-bound CLI: it walks the user through a scope
 * prompt before installing. cast already passes a specific skill (and
 * optionally a repo), so the only remaining prompt is project-vs-global; `-y`
 * short-circuits it, auto-detecting `global` because the CLI is invoked from
 * `homedir()` rather than a project. stderr is surfaced even on success —
 * that is where "Failed to install 1" appears.
 */
export async function runSkillsSh(args: string[], timeout: number): Promise<string> {
	const fullArgs = args.includes("-y") || args.includes("--yes") ? args : [...args, "-y"];
	try {
		const { stdout, stderr } = await execFileAsync("npx", ["--yes", "skills", ...fullArgs], {
			cwd: homedir(),
			encoding: "utf-8",
			timeout,
		});
		const out = stripAnsi(stdout).trim();
		const err = stripAnsi(stderr || "").trim();
		if (err && !out.includes(err)) return `${out}\n${err}`.trim();
		return out;
	} catch (error) {
		const execError = error as { stdout?: string; stderr?: string; message?: string };
		const out = stripAnsi(execError.stdout || "").trim();
		const err = stripAnsi(execError.stderr || execError.message || String(error)).trim();
		const combined = [out, err].filter(Boolean).join("\n").trim();
		throw new Error(combined || "skills.sh failed");
	}
}

export function skillsShInstall(input: string): Promise<string> {
	const args = normalizeSkillsShInstallArgs(input);
	if (args.length === 0) throw new Error("Usage: /skills-sh install <owner/repo> --skill <name>");
	return runSkillsSh(["add", ...args], SKILLS_SH_INSTALL_TIMEOUT_MS);
}

export function skillsShListAvailable(repo: string): Promise<string> {
	if (!repo.trim()) throw new Error("Usage: /skills-sh list-available <owner/repo>");
	return runSkillsSh(["add", repo.trim(), "--list"], SKILLS_SH_QUERY_TIMEOUT_MS);
}

export function skillsShSearch(query: string): Promise<string> {
	if (!query.trim()) throw new Error("Usage: /skills-sh search <query>");
	return runSkillsSh(["find", ...query.trim().split(WHITESPACE_SPLIT)], SKILLS_SH_QUERY_TIMEOUT_MS);
}

/**
 * Remove an installed skill. `--global` is required: cast installs into the
 * universal scope, and without it the CLI only searches the current project
 * and reports a successful no-op for something like
 * `~/.agents/skills/pr-review`.
 */
export function skillsShUninstall(names: string): Promise<string> {
	if (!names.trim()) throw new Error("Usage: /skills-sh uninstall <name>");
	return runSkillsSh(
		["remove", "--global", "--yes", ...names.trim().split(WHITESPACE_SPLIT)],
		SKILLS_SH_REMOVE_TIMEOUT_MS,
	);
}
