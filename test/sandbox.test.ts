import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSandboxInvocation,
	createShellInvocation,
	sandboxEnvironment,
	sandboxSettings,
} from "../src/core/sandbox.ts";
import { sandboxDirFor } from "../src/core/scratchpad.ts";

describe("sandbox process policy", () => {
	it("denies network by default and limits writes to the sandbox and its temporary directory", () => {
		const home = join("home", "user");
		const cwd = join(home, ".cast", "sandbox", "cast-s1");
		const temp = join("tmp", "cast-srt-a1");
		const settings = sandboxSettings(cwd, temp, home);
		expect(settings.network).toMatchObject({ strictAllowlist: true, allowedDomains: [], deniedDomains: [] });
		expect(settings.git.safeDirectories).toEqual([cwd]);
		expect(settings.filesystem.allowRead).toContain(cwd);
		expect(settings.filesystem.allowWrite).toEqual([cwd, temp]);
		expect(settings.filesystem.denyRead).toContain(home);
		expect(settings.filesystem.denyRead).toContain(join(home, ".ssh"));
		expect(settings.filesystem.denyRead).toContain(join(home, ".aws"));
		expect(settings.filesystem.denyWrite).toContain(join(cwd, ".env"));
	});

	it("builds an argv-only sandbox launch and removes credential-shaped environment variables", () => {
		const invocation = buildSandboxInvocation(
			"/app/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
			"/tmp/cast-srt-a1/settings.json",
			"/usr/bin/bash",
			"printf '%s' 'hello; touch /tmp/pwned'",
			{
				PATH: "/usr/bin",
				OPENAI_API_KEY: "secret",
				GITHUB_TOKEN: "secret",
				TERM: "xterm-256color",
			},
		);
		expect(invocation.executable).toBe(process.execPath);
		expect(invocation.args).toEqual([
			"/app/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
			"--settings",
			"/tmp/cast-srt-a1/settings.json",
			"--",
			"/usr/bin/bash",
			"-c",
			"printf '%s' 'hello; touch /tmp/pwned'",
		]);
		expect(invocation.env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color" });
	});

	it("sanitizes secret variables without changing ordinary shell variables", () => {
		expect(
			sandboxEnvironment({
				PATH: "/usr/bin",
				CAST_SESSION_ID: "s1",
				AWS_SECRET_ACCESS_KEY: "secret",
				NPM_TOKEN: "secret",
				DB_PASSWORD: "secret",
			}),
		).toEqual({ PATH: "/usr/bin", CAST_SESSION_ID: "s1" });
	});

	it("prepares a real runtime command only for the session's exact sandbox directory", () => {
		const sessionId = "sandbox-test-1";
		const cwd = sandboxDirFor(sessionId);
		const invocation = createShellInvocation(sessionId, cwd, "bash", "echo safe", { PATH: "/usr/bin" });
		try {
			expect(invocation.executable).toBe(process.execPath);
			expect(invocation.args[0]).toContain("@anthropic-ai");
			expect(invocation.args.slice(-3)).toEqual(["bash", "-c", "echo safe"]);
		} finally {
			invocation.cleanup();
		}
		expect(createShellInvocation(sessionId, `${cwd}-similar`, "bash", "echo plain", {}).executable).toBe("bash");
	});
});
