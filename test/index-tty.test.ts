import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("cast without a terminal", () => {
	it("says it needs one, and does not write screen sequences into the pipe", () => {
		const home = mkdtempSync(join(tmpdir(), "cast-tty-"));
		try {
			const run = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
				cwd: process.cwd(),
				env: { ...process.env, HOME: home, CAST_NO_DAEMON: "1" },
				input: "",
				encoding: "utf-8",
				timeout: 30_000,
			});
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("needs an interactive terminal");
			expect(run.stderr).toContain("cast run");
			expect(run.stdout).not.toContain("\x1b[?1049h");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
