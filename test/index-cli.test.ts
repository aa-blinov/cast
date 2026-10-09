/**
 * The command line of the bundle, for the parsing that decides what reaches the model and what a daemon is told:
 * a wrong flag is refused before anything starts, and a flag after the message is still a flag. These spawn the built
 * bundle with an empty HOME, like run-cli.test.ts, and check the exit code as well as the text.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

let home: string;

function cast(args: string[]) {
	const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", DIST_ENTRY, ...args], {
		encoding: "utf-8",
		input: "",
		timeout: 30_000,
		env: { ...process.env, HOME: home, CAST_CWD: home, CAST_SERVER_PORT: "0", CAST_SERVER_HOST: "127.0.0.1" },
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "cast-index-cli-"));
});

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!existsSync(DIST_ENTRY))("cast command line (top level)", () => {
	it("refuses an unknown flag instead of sending it to the model as the first prompt", () => {
		const { code, stdout, stderr } = cast(["--forse"]);
		expect(code).toBe(2);
		expect(stdout).toBe("");
		expect(stderr).toContain("unknown option --forse");
	});

	it("refuses a value-taking flag with no value, or with another flag in its place", () => {
		for (const [args, reason] of [
			[["-m"], "-m requires a value"],
			[["-p", "-c"], "-p requires a value"],
			[["--session"], "--session requires a value"],
		] as const) {
			const { code, stderr } = cast([...args]);
			expect(code, args.join(" ")).toBe(2);
			expect(stderr).toContain(reason);
		}
	});
});

describe.skipIf(!existsSync(DIST_ENTRY))("cast run flags after the message", () => {
	it("reads a flag that follows the message words, so a bad value is refused", () => {
		const { code, stderr } = cast(["run", "fix", "the", "bug", "--format", "yaml"]);
		expect(code).toBe(2);
		expect(stderr).toContain("--format must be default or json");
	});

	it("refuses an unknown flag that follows the message words", () => {
		const { code, stderr } = cast(["run", "fix", "the", "bug", "--nosuchflag"]);
		expect(code).toBe(2);
		expect(stderr).toContain("unknown option --nosuchflag");
	});
});

describe.skipIf(!existsSync(DIST_ENTRY))("cast server and cast lsp arguments", () => {
	it("refuses a port that is not a number in range, before any daemon starts", () => {
		for (const args of [
			["server", "--port", "abc"],
			["server", "--port=70000"],
			["server", "--port", "-1"],
		]) {
			const { code, stderr } = cast(args);
			expect(code, args.join(" ")).toBe(2);
			expect(stderr).toContain("--port must be a number from 0 to 65535");
		}
	});

	it("refuses a line or character that is not a whole number", () => {
		const { code, stderr } = cast(["lsp", "references", "a.ts", "1", "x"]);
		expect(code).toBe(2);
		expect(stderr).toContain("line and character must be whole numbers");
	});
});
