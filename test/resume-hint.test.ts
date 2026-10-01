import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectShell,
	lastResumePath,
	resumeCommand,
	resumeHint,
	shellInit,
	writeLastResume,
} from "../src/ui/resume-hint.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string | undefined) => line?.replace(/\x1b\[[0-9;]*m/g, "");

describe("resumeHint", () => {
	it("names a session that had a turn, whether or not there are earlier ones", () => {
		expect(plain(resumeHint({ id: "abc", hasMessages: true }, false))).toBe("Resume this session: cast --resume=abc");
		expect(plain(resumeHint({ id: "abc", hasMessages: true }, true))).toBe("Resume this session: cast --resume=abc");
	});

	it("points an empty session to the folder's earlier ones, for a cleared or never-used conversation", () => {
		expect(plain(resumeHint({ id: "abc", hasMessages: false }, true))).toBe(
			"Earlier session in this folder: cast --continue  (or cast --resume to pick)",
		);
	});

	it("says nothing when there is nothing to go back to", () => {
		expect(resumeHint({ id: "abc", hasMessages: false }, false)).toBeUndefined();
		expect(resumeCommand({ id: "abc", hasMessages: false }, false)).toBeUndefined();
	});

	it("gives the bare command the shell history gets", () => {
		expect(resumeCommand({ id: "abc", hasMessages: true }, true)).toBe("cast --resume=abc");
		expect(resumeCommand({ id: "abc", hasMessages: false }, true)).toBe("cast --continue");
	});
});

describe("the file the shell function reads", () => {
	let dir: string;
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.CAST_HOME;
		dir = mkdtempSync(join(tmpdir(), "cast-resume-"));
		process.env.CAST_HOME = dir;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.CAST_HOME;
		else process.env.CAST_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("is written with the command, and cleared when there is none", () => {
		writeLastResume("cast --resume=abc");
		expect(readFileSync(lastResumePath(), "utf-8")).toBe("cast --resume=abc\n");
		writeLastResume(undefined);
		expect(existsSync(lastResumePath())).toBe(false);
	});

	it("never throws when the folder cannot be written", () => {
		process.env.CAST_HOME = join(dir, "file-not-dir", "x");
		writeFileSync(join(dir, "file-not-dir"), "");
		expect(() => writeLastResume("cast --resume=abc")).not.toThrow();
	});
});

describe("detectShell", () => {
	it("takes the name given, else the login shell, and refuses anything else", () => {
		expect(detectShell("fish", {})).toBe("fish");
		expect(detectShell(undefined, { SHELL: "/usr/bin/zsh" })).toBe("zsh");
		expect(detectShell(undefined, { SHELL: "/bin/bash" })).toBe("bash");
		expect(detectShell("powershell", {})).toBeUndefined();
		expect(detectShell(undefined, {})).toBeUndefined();
	});
});

const has = (shell: string) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;

describe("shellInit", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-shell-"));
		// A stand-in `cast` that leaves the file the way an interactive exit does.
		writeFileSync(join(dir, "cast"), `#!/bin/sh\necho "cast --resume=abc123" > "$CAST_HOME/last-resume"\nexit 3\n`);
		chmodSync(join(dir, "cast"), 0o755);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.skipIf(!has("bash"))("puts the command in bash's history, keeps cast's exit status, and leaves no file", () => {
		writeFileSync(join(dir, "init.sh"), shellInit("bash"));
		const run = spawnSync(
			"bash",
			["--norc", "-i", "-c", `source ${join(dir, "init.sh")}; cast; echo "rc=$?"; history | tail -2`],
			{ env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CAST_HOME: dir, HISTFILE: "" }, encoding: "utf-8" },
		);
		expect(run.stdout).toContain("rc=3");
		expect(run.stdout).toContain("cast --resume=abc123");
		expect(existsSync(join(dir, "last-resume"))).toBe(false);
	});

	it.skipIf(!has("zsh"))("puts the command in zsh's history too", () => {
		writeFileSync(join(dir, "init.zsh"), shellInit("zsh"));
		const run = spawnSync(
			"zsh",
			["-f", "-i", "-c", `source ${join(dir, "init.zsh")}; cast; echo "rc=$?"; fc -l -1`],
			{
				env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CAST_HOME: dir },
				encoding: "utf-8",
			},
		);
		expect(run.stdout).toContain("rc=3");
		expect(run.stdout).toContain("cast --resume=abc123");
	});

	it.skipIf(!has("bash"))("adds nothing when this run left no file, even if an old one was lying there", () => {
		writeFileSync(join(dir, "cast"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(dir, "cast"), 0o755);
		writeFileSync(join(dir, "last-resume"), "cast --resume=stale\n");
		writeFileSync(join(dir, "init.sh"), shellInit("bash"));
		const run = spawnSync("bash", ["--norc", "-i", "-c", `source ${join(dir, "init.sh")}; cast; history | tail -2`], {
			env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, CAST_HOME: dir, HISTFILE: "" },
			encoding: "utf-8",
		});
		expect(run.stdout).not.toContain("stale");
	});

	it("writes a function for fish as well, without bash syntax", () => {
		const fish = shellInit("fish");
		expect(fish).toContain("function cast");
		expect(fish).toContain("builtin history append");
		expect(fish).not.toContain("local ");
	});
});
