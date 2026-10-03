import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };

// bin/cast is a shell script; the Windows launcher is cast.cmd and has no such fast path.
describe.skipIf(process.platform === "win32")("bin/cast launcher", () => {
	it("answers a lone --version or -v itself, with the package version, without starting node", () => {
		for (const flag of ["--version", "-v"]) {
			// A node started with a module that does not exist exits with an error, so a launcher that still tried
			// to start the bundle would fail here instead of printing the version.
			const result = spawnSync("/bin/bash", [join(root, "bin", "cast"), flag], {
				encoding: "utf-8",
				env: { ...process.env, NODE_OPTIONS: "--require=/nonexistent/never-loaded.js" },
			});
			expect(result.stdout.trim(), flag).toBe(`cast v${version}`);
			expect(result.status).toBe(0);
		}
	});
});
