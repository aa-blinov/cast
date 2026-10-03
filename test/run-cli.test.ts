/**
 * `cast run` as a script author meets it: what a wrong command line does, and what a first run on a machine with
 * nothing configured does. These spawn the built bundle (CI builds before it tests), each with its own empty HOME so
 * nothing of the developer's settings or daemon is touched.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

let home: string;

function cast(args: string[], options: { input?: string; timeout?: number } = {}) {
	const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", DIST_ENTRY, "run", ...args], {
		encoding: "utf-8",
		input: options.input ?? "",
		timeout: options.timeout ?? 30_000,
		env: { ...process.env, HOME: home, CAST_CWD: home, CAST_SERVER_PORT: "0", CAST_SERVER_HOST: "127.0.0.1" },
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "cast-run-cli-"));
});

afterAll(() => {
	// The no-provider test starts a daemon under this HOME; stop it before the directory goes.
	const state = join(home, ".cast", "server.json");
	if (existsSync(state)) {
		try {
			process.kill((JSON.parse(readFileSync(state, "utf-8")) as { pid: number }).pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!existsSync(DIST_ENTRY))("cast run command line", () => {
	it("exits 2 with a one-line reason for a command written wrong, and does not send it to the model", () => {
		const cases: Array<[string[], string]> = [
			[["--nosuchflag", "hi"], "unknown option --nosuchflag"],
			[["-m"], "-m requires a value"],
			[["--format", "yaml", "hi"], "--format must be default or json"],
			[["-r", "bogus", "hi"], 'unknown reasoning level "bogus"'],
			[["-w"], "--worktree requires a name"],
		];
		for (const [args, reason] of cases) {
			const { code, stdout, stderr } = cast(args);
			expect(code, args.join(" ")).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toContain(reason);
			expect(stderr).not.toContain("    at ");
		}
	});

	it("needs a message: an empty stdin is a usage error, not a hang", () => {
		const { code, stderr } = cast([], { input: "" });
		expect(code).toBe(2);
		expect(stderr).toContain("the prompt from stdin is empty");
	});

	it("lists its exit codes in --help", () => {
		const { code, stdout } = cast(["--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Exit codes: 0 success, 1 the run failed, 2 the command was written wrong");
	});

	// A fresh machine (a CI container) has no ~/.cast: the start lock failed with ENOENT, read as "held", and the run
	// spun for a minute with nothing printed; after that it waited forever for a turn that had already failed.
	it("on a machine with nothing configured, fails in seconds and says what is missing", () => {
		const { code, stdout, stderr } = cast(["hi"], { timeout: 45_000 });
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("No provider is configured");
	}, 60_000);
});
