import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDaemonLog } from "../src/server/daemon-log.ts";

/**
 * `cast server start` redirects the daemon's stdout and stderr into this file,
 * so it has to be openable before anything is spawned. Unguarded, an
 * unwritable ~/.cast made the command exit with a raw
 * "EACCES: permission denied, open …/server.log" and a stack through the
 * minified bundle — naming the log file, never saying the directory was the
 * problem. Reproduced by chmod 500 on the directory.
 */
describe("openDaemonLog", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-daemon-log-"));
	});

	afterEach(() => {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens the log in a writable directory", () => {
		const path = join(dir, "server.log");
		const result = openDaemonLog(path);
		expect(result.ok).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	it("explains an unwritable directory instead of surfacing a bare EACCES", () => {
		const nested = join(dir, "cast");
		mkdirSync(nested);
		chmodSync(nested, 0o500);
		const path = join(nested, "server.log");

		const result = openDaemonLog(path);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		const text = result.failure.lines.join("\n");
		expect(text).toContain(path);
		expect(text).toContain(nested);
		expect(text).toMatch(/writable by this user/);
		expect(text).toMatch(/EACCES|permission denied/);
		chmodSync(nested, 0o700);
	});

	it("creates a missing directory instead of refusing to start", () => {
		// `cast server start` can be the first cast command on a machine, with
		// nothing having created ~/.cast yet — that used to be an ENOENT and a
		// message telling the user to check a directory that never existed.
		const path = join(dir, "does", "not", "exist", "server.log");

		const result = openDaemonLog(path);

		expect(result.ok).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	it("still explains a directory it cannot create", () => {
		const nested = join(dir, "cast");
		mkdirSync(nested);
		chmodSync(nested, 0o500);

		const result = openDaemonLog(join(nested, "sub", "server.log"));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.lines.join("\n")).toContain("exists and is writable");
		chmodSync(nested, 0o700);
	});
});
