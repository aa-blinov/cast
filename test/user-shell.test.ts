import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { parseUserShellInput, parseUserShellMessage, runUserShell, userShellMessage } from "../src/core/user-shell.ts";

const config: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 20_000,
};
const here = process.cwd();

describe("parseUserShellInput", () => {
	it("takes `!command` as a command, `!` alone as empty, and `!!text` as a message for the model", () => {
		expect(parseUserShellInput("!ls -la")).toEqual({ kind: "run", command: "ls -la" });
		expect(parseUserShellInput("!  git status  ")).toEqual({ kind: "run", command: "git status" });
		expect(parseUserShellInput("!")).toEqual({ kind: "empty" });
		expect(parseUserShellInput("!   ")).toEqual({ kind: "empty" });
		expect(parseUserShellInput("!!important: fix it")).toEqual({ kind: "text", text: "!important: fix it" });
		expect(parseUserShellInput("fix it !now")).toBeUndefined();
		expect(parseUserShellInput("/help")).toBeUndefined();
	});
});

describe("user shell message", () => {
	it("round-trips the command and its output, including quotes, tags and an output that holds the closing tag", () => {
		for (const [command, output] of [
			["ls -la", "total 0\nfile"],
			['echo "a" && echo <b> & c', "x"],
			["cat f", "before </user-shell> after"],
			["true", ""],
		] as const) {
			expect(parseUserShellMessage(userShellMessage(command, output))).toEqual({ command, output });
		}
	});

	it("tells the model it did not run the command, and recognises no other text", () => {
		expect(userShellMessage("ls", "a")).toContain("(you did not run it)");
		expect(parseUserShellMessage("hello")).toBeUndefined();
		expect(parseUserShellMessage('<user-shell command="ls">\na\n</user-shell>')).toBeUndefined();
	});
});

describe("runUserShell (real bash)", () => {
	const deps = { cwd: here, config, readOnly: false };

	it("runs the command and returns its output as a message for the conversation", async () => {
		const result = await runUserShell("echo hello-from-user", deps);
		expect(result).toMatchObject({ ran: true, failed: false });
		if (!result.ran) return;
		expect(result.output).toContain("hello-from-user");
		expect(parseUserShellMessage(result.message)?.command).toBe("echo hello-from-user");
	});

	it("runs in the folder it is given", async () => {
		const result = await runUserShell("pwd", { ...deps, cwd: "/tmp" });
		expect(result.ran && result.output.trim().endsWith("/tmp")).toBe(true);
	});

	it("still reports a command that failed, flagged as failed, so the person sees the error", async () => {
		const result = await runUserShell("echo oops >&2; exit 3", deps);
		expect(result).toMatchObject({ ran: true, failed: true });
		if (result.ran) expect(result.output).toContain("oops");
	});

	it("in plan mode runs only inspection commands, and says why when it does not", async () => {
		const read = await runUserShell("ls /tmp", { ...deps, readOnly: true });
		expect(read.ran).toBe(true);
		const write = await runUserShell("touch /tmp/should-not-exist-user-shell", { ...deps, readOnly: true });
		expect(write).toMatchObject({ ran: false });
		if (!write.ran) expect(write.reason).toContain("plan mode allows read-only commands only");
	});

	it("asks about a dangerous command, and does not run it when the answer is no", async () => {
		const confirm = vi.fn(async () => false);
		const result = await runUserShell("rm -rf /tmp/never-created-user-shell-dir", { ...deps, confirm });
		expect(confirm).toHaveBeenCalled();
		expect(result).toMatchObject({ ran: false });
		if (!result.ran) expect(result.reason).toMatch(/Blocked/);
	});

	it("runs a dangerous command the person confirmed", async () => {
		const confirm = vi.fn(async () => true);
		const result = await runUserShell("rm -rf /tmp/never-created-user-shell-dir", { ...deps, confirm });
		expect(result).toMatchObject({ ran: true, failed: false });
	});
});
