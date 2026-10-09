import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/core/file-lock.ts";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-file-lock-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
	it("returns the work's value and removes its lock afterwards", () => {
		const lock = join(dir, "x.lock");
		expect(withFileLock(lock, () => 42)).toBe(42);
		expect(existsSync(lock)).toBe(false);
	});

	it("takes over a lock whose owner is gone", () => {
		const lock = join(dir, "x.lock");
		// No process has this pid: the owner died holding the lock.
		writeFileSync(lock, "2147483646");
		expect(withFileLock(lock, () => "went through")).toBe("went through");
		expect(existsSync(lock)).toBe(false);
	});

	it("does not take over a lock whose owner is alive, and fails rather than writing without it", () => {
		const lock = join(dir, "x.lock");
		// This process is alive, so the lock is genuinely held.
		writeFileSync(lock, String(process.pid));
		expect(() => withFileLock(lock, () => "never", 30)).toThrow(/Timed out waiting for the lock/);
		expect(existsSync(lock)).toBe(true);
	});
});
