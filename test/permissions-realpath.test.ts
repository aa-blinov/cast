import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A path that vanishes between existsSync and realpathSync (or one realpath
// can't resolve) must not throw out of the permission gate.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		realpathSync: () => {
			throw new Error("ENOENT: vanished");
		},
	};
});

const { externalTarget } = await import("../src/core/permissions.ts");

describe("externalTarget when realpath fails", () => {
	it("falls back to the path as given", () => {
		const root = mkdtempSync(join(tmpdir(), "cast-realpath-"));
		try {
			expect(externalTarget("read", { path: join(root, "x") }, join(root, "proj"), join(root, "proj"))).toEqual({
				path: join(root, "x"),
				dir: root,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
