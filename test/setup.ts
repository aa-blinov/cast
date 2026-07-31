import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Keep tests from reading or mutating the developer's real ~/.cast. Individual
// tests may temporarily point HOME at a narrower fixture and restore this one.
const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "cast-vitest-home-"));
process.env.HOME = testHome;

afterAll(() => {
	process.env.HOME = originalHome;
	rmSync(testHome, { recursive: true, force: true });
});
