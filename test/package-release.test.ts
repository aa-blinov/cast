import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const target = `${platform}-${process.arch}`;
const supportedTargets = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
]);

describe("release staging", () => {
	it.runIf(supportedTargets.has(target))("ships the sandbox runtime and its locked dependencies", () => {
		const stage = mkdtempSync(join(tmpdir(), "cast-release-test-"));
		try {
			const result = spawnSync(
				process.execPath,
				["scripts/package-release.mjs", "--target", target, "--stage", stage],
				{ encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			const requireFromBundle = createRequire(join(stage, "dist", "index.js"));
			expect(requireFromBundle.resolve("@anthropic-ai/sandbox-runtime")).toBe(
				join(stage, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "index.js"),
			);
			expect(existsSync(join(stage, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js"))).toBe(
				true,
			);
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});
});
