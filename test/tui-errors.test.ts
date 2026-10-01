import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logTuiError } from "../src/ui/tui-errors.ts";

describe("logTuiError", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-tui-errors-"));
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("appends a line to ~/.cast/tui-errors.log, creating the folder", () => {
		logTuiError("render error", "boom");
		logTuiError("unhandled rejection", "later");
		const path = join(fakeHome, ".cast", "tui-errors.log");
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.* render error: boom$/);
		expect(lines[1]).toContain("unhandled rejection: later");
	});

	it("does not throw when there is nowhere to write", () => {
		process.env.HOME = join(fakeHome, "does", "not", "exist", "\0bad");
		expect(() => logTuiError("x", "y")).not.toThrow();
	});
});
