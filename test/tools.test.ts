import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { MessageQueue } from "../src/core/loop.ts";
import { MAX_PLAN_CHARS, PLAN_TOOL_NAMES, type PlanState } from "../src/core/plan.ts";
import { BackgroundTaskRegistry, type BashBackgroundDeps } from "../src/core/tools/bash-background.ts";
import { isPermissionError, withAccessNote } from "../src/core/tools/search.ts";
import { createToolExecutor, getToolDefinitions } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "tools");

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 10,
};

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ============================================================================
// bash
// ============================================================================

describe("bash", () => {
	it("rejects a missing command instead of reporting a no-op as success", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", {});
		expect(result.isError).toBe(true);
		expect(result.content).toContain('"command" is required');
	});

	it("executes a command and returns output", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "echo hello" });
		expect(result.content.trim()).toBe("hello");
		expect(result.isError).toBeFalsy();
	});

	it("returns stderr on failure", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "ls /nonexistent_path_12345" });
		expect(result.isError).toBe(true);
	});

	it("marks byte-limited output so the agent does not mistake it for complete output", async () => {
		const exec = createToolExecutor(TEST_DIR, { ...mockConfig, maxToolOutputBytes: 10 });
		const result = await exec("bash", { command: "printf 123456789012345" });
		expect(result.content).toContain("Output truncated at 10B");
	});

	// Live-echo gating: only a command that looks like it's waiting for input
	// (still running past the grace + non-newline-terminated output) is shown
	// live; fast and long-but-line-buffered commands stay silent (captured only),
	// so their output isn't duplicated on screen.
	function captureStderr() {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		}) as typeof process.stderr.write);
		return { writes, restore: () => spy.mockRestore() };
	}

	it("does not echo a fast command live — captured only, no duplication", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const { writes, restore } = captureStderr();
		try {
			const result = await exec("bash", { command: "echo fast-marker-1" });
			expect(result.content.trim()).toBe("fast-marker-1");
			expect(writes.join("")).not.toContain("fast-marker-1");
		} finally {
			restore();
		}
	});

	it("does not echo a slow but newline-terminated (non-interactive) command live", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const { writes, restore } = captureStderr();
		try {
			// Line-buffered output while still running past the grace — like a long
			// test streaming logs. Must NOT be revealed live.
			const result = await exec("bash", { command: "echo slow-line-marker; sleep 0.5" });
			expect(result.content).toContain("slow-line-marker");
			expect(writes.join("")).not.toContain("slow-line-marker");
		} finally {
			restore();
		}
	});

	it("blocks interactive read -p command", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "read -p 'Name: ' name && echo Hello_$name" });
		expect(result.isError).toBe(true);
		// stdin is /dev/null — read gets EOF and the command fails
	});

	it("respects timeout", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "sleep 10", timeout: 1 });
		// Process is killed — either isError or output contains timeout info
		expect(
			result.isError === true || result.content.includes("timeout") || result.content.includes("exit code"),
		).toBe(true);
	});

	it("kills an in-flight command as soon as the AbortSignal fires, not just the next request", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const controller = new AbortController();

		const start = Date.now();
		const resultPromise = exec("bash", { command: "sleep 30", timeout: 60 }, controller.signal);
		// Give the process a moment to actually start, then abort — this is
		// the exact "long command already running" case /abort is for.
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();

		const result = await resultPromise;
		const elapsed = Date.now() - start;

		expect(result.isError).toBe(true);
		expect(result.content).toContain("[ABORTED]");
		// Killed promptly, nowhere near the 30s sleep or 60s timeout it would
		// otherwise have run for.
		expect(elapsed).toBeLessThan(5000);
	});

	it("returns immediately without spawning if already aborted before the call", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const controller = new AbortController();
		controller.abort();

		const start = Date.now();
		const result = await exec("bash", { command: "sleep 30" }, controller.signal);
		const elapsed = Date.now() - start;

		expect(result.isError).toBe(true);
		expect(elapsed).toBeLessThan(1000);
	});

	it("does not call confirmBash for ordinary commands", async () => {
		const confirmBash = vi.fn(async () => true);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		await exec("bash", { command: "echo hello" });
		expect(confirmBash).not.toHaveBeenCalled();
	});

	it("asks confirmBash before a dangerous command, and runs it if allowed", async () => {
		const confirmBash = vi.fn(async () => true);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		// `-n` (non-interactive) makes sudo fail fast with "a password is
		// required" instead of prompting — deterministic everywhere, unlike a
		// bare `sudo echo x`, which relies on there being no controlling TTY
		// (true here, but not guaranteed on a machine with an askpass helper
		// or NOPASSWD sudoers entry) to avoid hanging on a password prompt.
		const result = await exec("bash", { command: "echo would-be-dangerous && sudo -n true" });
		expect(confirmBash).toHaveBeenCalledTimes(1);
		expect(confirmBash.mock.calls[0]?.[1]).toContain("sudo");
		expect(result.content).toContain("would-be-dangerous");
	});

	it("blocks a dangerous command without executing it if confirmBash denies", async () => {
		const confirmBash = vi.fn(async () => false);
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirmBash);
		const result = await exec("bash", { command: "sudo rm -rf /tmp/should-not-run" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Blocked");
	});
});

// ============================================================================
// bash — run_in_background / bash_output / bash_kill
// ============================================================================

function makeBackgroundDeps(running = false) {
	const registry = new BackgroundTaskRegistry();
	const followUpQueue = new MessageQueue();
	let isRunningFlag = running;
	const deps: BashBackgroundDeps = { registry, followUpQueue, isRunning: () => isRunningFlag };
	return {
		deps,
		registry,
		followUpQueue,
		setRunning: (v: boolean) => {
			isRunningFlag = v;
		},
	};
}

describe("bash — run_in_background", () => {
	it("automatically backgrounds an obvious server command", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		try {
			const start = Date.now();
			const result = await exec("bash", { command: "python3 -m http.server 8000" });
			expect(Date.now() - start).toBeLessThan(500);
			expect(result.isError).toBeFalsy();
			expect(result.content).toMatch(/Automatically moved to background as bg-\d+/);
		} finally {
			deps.registry.killAll();
		}
	});

	it("promotes a generic command after the foreground grace period", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(
			TEST_DIR,
			{ ...mockConfig, defaultBashTimeout: 0.1 },
			undefined,
			undefined,
			undefined,
			undefined,
			deps,
		);
		try {
			const result = await exec("bash", { command: "sleep 5" });
			expect(result.isError).toBeFalsy();
			expect(result.content).toMatch(/Automatically moved to background as bg-\d+/);
			expect(deps.registry.hasRunning()).toBe(true);
		} finally {
			deps.registry.killAll();
		}
	});

	it("returns immediately with a task id instead of waiting for the command", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const start = Date.now();
		const result = await exec("bash", { command: "sleep 1 && echo done", run_in_background: true });
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(500);
		expect(result.isError).toBeFalsy();
		expect(result.content).toMatch(/Started in background as bg-\d+/);
	});

	it("falls back to running synchronously when no background deps are configured", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash", { command: "echo hi", run_in_background: true });
		expect(result.content.trim()).toBe("hi");
		expect(result.content).not.toContain("Started in background");
	});

	it("delivers completion onto followUpQueue while the runner is still marked running", async () => {
		const { deps, followUpQueue } = makeBackgroundDeps(true);
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		await exec("bash", { command: "echo from-bg", run_in_background: true });
		await new Promise((r) => setTimeout(r, 300));
		const drained = followUpQueue.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0]?.role).toBe("user");
		expect(String(drained[0]?.content)).toContain("<system-reminder>");
		expect(String(drained[0]?.content)).toContain("from-bg");
	});

	it("wakes an idle session via the registry's onIdleWake instead of the queue", async () => {
		const { deps, registry, followUpQueue } = makeBackgroundDeps(false);
		const wake = vi.fn();
		registry.setOnIdleWake(wake);
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		await exec("bash", { command: "echo idle-wake", run_in_background: true });
		await new Promise((r) => setTimeout(r, 300));
		expect(wake).toHaveBeenCalledTimes(1);
		expect(String(wake.mock.calls[0]?.[0])).toContain("idle-wake");
		expect(followUpQueue.drain()).toHaveLength(0);
	});

	it("reports a spawn failure as a single 'error' status, not overwritten by a later 'close'", async () => {
		// Node fires 'close' right behind 'error' for a failed spawn (ENOENT).
		// Without a guard, close's handler downgraded status "error" back to
		// "exited" with a meaningless exit code and re-ran settle(), both
		// losing the real error message and delivering two completion
		// notifications for one failure. An empty PATH makes the OS-level
		// lookup for "bash" fail at spawn time — resolveBash()'s own
		// process-wide cache (already warmed to a real "bash" by earlier
		// tests in this file) is irrelevant here since it just returns the
		// literal string "bash" on non-win32; PATH resolution happens fresh
		// on every spawn() call, not at resolveBash() time.
		const originalPath = process.env.PATH;
		const emptyPathDir = join(TEST_DIR, "__empty_path_for_bg_spawn_test__");
		mkdirSync(emptyPathDir, { recursive: true });
		process.env.PATH = emptyPathDir;
		try {
			const { deps, registry } = makeBackgroundDeps(false);
			const wake = vi.fn();
			registry.setOnIdleWake(wake);
			const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
			const started = await exec("bash", { command: "echo hi", run_in_background: true });
			const taskId = started.content.match(/bg-\d+/)?.[0];
			await new Promise((r) => setTimeout(r, 300));

			expect(wake).toHaveBeenCalledTimes(1);
			expect(String(wake.mock.calls[0]?.[0])).toContain("failed to start");

			const status = await exec("bash_output", { task_id: taskId });
			expect(status.isError).toBe(true);
			expect(status.content).toContain("failed to start");
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe("background bash tool definitions", () => {
	it("omits bash_output, bash_kill, and bash's run_in_background param by default", () => {
		const tools = getToolDefinitions();
		expect(tools.find((t) => t.function.name === "bash_output")).toBeUndefined();
		expect(tools.find((t) => t.function.name === "bash_kill")).toBeUndefined();
		const bash = tools.find((t) => t.function.name === "bash");
		expect(bash?.function.parameters.properties).not.toHaveProperty("run_in_background");
	});

	it("includes bash_output, bash_kill, and bash's run_in_background param when enabled", () => {
		const tools = getToolDefinitions(undefined, undefined, undefined, undefined, true);
		expect(tools.find((t) => t.function.name === "bash_output")).toBeDefined();
		expect(tools.find((t) => t.function.name === "bash_kill")).toBeDefined();
		const bash = tools.find((t) => t.function.name === "bash");
		expect(bash?.function.parameters.properties).toHaveProperty("run_in_background");
		expect(bash?.function.description).toContain("automatically promoted");
		expect(bash?.function.parameters.properties.timeout.description).toContain("promoted to background");
	});
});

describe("todo_write tool definition — build-mode only", () => {
	it("is omitted by default (plan mode / not passed)", () => {
		const tools = getToolDefinitions();
		expect(tools.find((t) => t.function.name === "todo_write")).toBeUndefined();
	});

	it("is included when includeTodoTool is true", () => {
		const tools = getToolDefinitions(undefined, undefined, undefined, undefined, undefined, true);
		const def = tools.find((t) => t.function.name === "todo_write");
		expect(def).toBeDefined();
		expect(def?.function.parameters.required).toEqual(["todos"]);
	});
});

describe("skill tool definition", () => {
	it("is omitted when no model-invokable skills are available", () => {
		const tools = getToolDefinitions(undefined, undefined, undefined, undefined, undefined, undefined, false);
		expect(tools.find((t) => t.function.name === "skill")).toBeUndefined();
	});
});

describe("web_search tool definition — provider-dependent schema", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(async () => {
		realHome = process.env.HOME;
		fakeHome = join(TEST_DIR, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
	});

	it("advertises DDG's region/time params by default", () => {
		const def = getToolDefinitions().find((t) => t.function.name === "web_search")?.function;
		expect(def?.description).toContain("DuckDuckGo");
		expect(def?.parameters.properties).toHaveProperty("region");
		expect(def?.parameters.properties).toHaveProperty("time");
	});

	it("omits region/time and names Tavily once searchProvider is 'tavily'", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({ searchProvider: "tavily", tavilyApiKey: "tvly-fake" });

		const def = getToolDefinitions().find((t) => t.function.name === "web_search")?.function;
		expect(def?.description).toContain("Tavily");
		expect(def?.parameters.properties).not.toHaveProperty("region");
		expect(def?.parameters.properties).not.toHaveProperty("time");
	});

	it("omits region/time and names Brave once searchProvider is 'brave'", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({ searchProvider: "brave", braveApiKey: "brave-fake" });

		const def = getToolDefinitions().find((t) => t.function.name === "web_search")?.function;
		expect(def?.description).toContain("Brave");
		expect(def?.parameters.properties).not.toHaveProperty("region");
		expect(def?.parameters.properties).not.toHaveProperty("time");
	});
});

describe("bash_output", () => {
	it("keeps a failed background task marked as an error", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const started = await exec("bash", { command: "exit 7", run_in_background: true });
		const taskId = started.content.match(/bg-\d+/)?.[0];
		const result = await exec("bash_output", { task_id: taskId, wait: 5 });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Process exited with code 7");
	});

	it("errors on an unknown task_id", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const result = await exec("bash_output", { task_id: "bg-999" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("bg-999");
	});

	it("errors when background support isn't configured", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("bash_output", { task_id: "bg-1" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not available");
	});

	it("reports running, then exited-with-output once the task finishes", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const started = await exec("bash", { command: "sleep 0.3 && echo bg-output-marker", run_in_background: true });
		const taskId = started.content.match(/bg-\d+/)?.[0];
		expect(taskId).toBeDefined();

		const running = await exec("bash_output", { task_id: taskId });
		expect(running.content).toContain("running");

		const finished = await exec("bash_output", { task_id: taskId, wait: 5 });
		expect(finished.content).toContain("bg-output-marker");
		expect(finished.content).toContain("exited with code 0");
	});
});

describe("bash_kill", () => {
	it("kills a running background task", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const started = await exec("bash", { command: "sleep 30", run_in_background: true });
		const taskId = started.content.match(/bg-\d+/)?.[0];

		const killed = await exec("bash_kill", { task_id: taskId });
		expect(killed.content).toContain("killed");

		await new Promise((r) => setTimeout(r, 300));
		const status = await exec("bash_output", { task_id: taskId });
		expect(status.content).toContain("killed");
	});

	it("reports already-done on a second kill instead of erroring", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const started = await exec("bash", { command: "echo quick", run_in_background: true });
		const taskId = started.content.match(/bg-\d+/)?.[0];
		await new Promise((r) => setTimeout(r, 300));

		const result = await exec("bash_kill", { task_id: taskId });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("already");
	});

	it("errors on an unknown task_id", async () => {
		const { deps } = makeBackgroundDeps();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, undefined, undefined, deps);
		const result = await exec("bash_kill", { task_id: "bg-999" });
		expect(result.isError).toBe(true);
	});
});

// ============================================================================
// read
// ============================================================================

describe("read", () => {
	it("reads a file with plain line numbers", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "line1\nline2\nline3\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt" });
		expect(result.content).toContain("1: line1");
		expect(result.content).toContain("2: line2");
		expect(result.content).toContain("3: line3");
	});

	it("supports offset and limit", async () => {
		writeFileSync(join(TEST_DIR, "test.txt"), "a\nb\nc\nd\ne\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "test.txt", offset: 2, limit: 2 });
		expect(result.content).toContain("2: b");
		expect(result.content).toContain("3: c");
		expect(result.content).not.toContain("4: d");
	});

	it("treats limit:0 as zero lines, not 'no limit' (0 is falsy)", async () => {
		// `limit ? ... : allLines.length` used to treat an explicit `limit: 0`
		// the same as "no limit given" (0 is falsy in JS) and dumped the whole
		// file instead of reading zero lines.
		writeFileSync(join(TEST_DIR, "limit-zero.txt"), "a\nb\nc\nd\ne\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "limit-zero.txt", limit: 0 });
		expect(result.isError).toBeFalsy();
		expect(result.content).not.toContain(": a");
		expect(result.content).not.toContain(": e");
		expect(result.content).toContain("Showing 0 lines");
	});

	it("caps output by bytes, not just line count, for a file with one huge line", async () => {
		// maxToolOutputLines doesn't help when a single line (minified bundle,
		// binary content with no newlines) is many times larger than the
		// output budget — read used to return the whole line regardless of
		// size, unlike every other tool (bash/ssh/grep) which enforces
		// config.maxToolOutputBytes.
		writeFileSync(join(TEST_DIR, "huge-line.txt"), "x".repeat(10 * mockConfig.maxToolOutputBytes));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "huge-line.txt" });
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThan(mockConfig.maxToolOutputBytes * 1.1);
		expect(result.content).toContain("truncated");
	});

	it("caps output by bytes across multiple long lines, stopping on a line boundary", async () => {
		const lineCount = 40;
		const line = `${"y".repeat(3000)}\n`;
		writeFileSync(join(TEST_DIR, "many-long-lines.txt"), line.repeat(lineCount));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "many-long-lines.txt" });
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(mockConfig.maxToolOutputBytes);
		expect(result.content).toMatch(new RegExp(`Showing lines 1-\\d+ of ${lineCount + 1}.*stopped at`));
		expect(result.content).toContain("Use offset=");
	});

	it("errors on missing file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "nonexistent.txt" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("File not found: nonexistent.txt");
	});

	it("on missing path, searches by basename and suggests real hits", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src", "greet.ts"), "export const hi = 1;\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "greet.ts" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("File not found: greet.ts");
		expect(result.content).toContain("src/greet.ts");
		expect(result.content).toMatch(/do not call glob/i);
	});

	it("preserves a tab-indented line's leading tabs verbatim", async () => {
		writeFileSync(join(TEST_DIR, "tabs.txt"), "if (x) {\n\t\tconst y = 1;\n}\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "tabs.txt" });
		expect(result.content).toContain("2: \t\tconst y = 1;");
		expect(result.content).not.toContain("\t\t\tconst y = 1;");
	});

	it("rejects empty path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("path");
	});
});

// ============================================================================
// read — images (resize pipeline wiring — see test/image-resize.test.ts for
// the codec logic itself; this just proves execRead actually calls it)
// ============================================================================

describe("read — images", () => {
	it("embeds a small image unresized", async () => {
		// 1x1 PNG — far under SKIP_RESIZE_BELOW_BYTES, so resizeImageForEmbedding
		// returns undefined and execRead must fall back to the original bytes.
		const onePixelPng = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(join(TEST_DIR, "tiny.png"), onePixelPng);
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "tiny.png" });
		expect(result.isError).toBeFalsy();
		expect(result.imageDataUrl).toBe(`data:image/png;base64,${onePixelPng.toString("base64")}`);
		expect(result.content).not.toContain("downscaled");
	});

	it("rejects a file over the sanity ceiling before ever trying to decode it", async () => {
		// Doesn't need to be a real image — the reject happens on stat.size,
		// before any read/decode is attempted.
		writeFileSync(join(TEST_DIR, "huge.jpg"), Buffer.alloc(26 * 1024 * 1024, 1));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "huge.jpg" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("too large");
	});

	it("downscales a real oversized jpeg and notes it in the result text", async () => {
		const { default: encodeJpeg, init: initJpegEncode } = await import("@jsquash/jpeg/encode.js");
		const { readFileSync: rf } = await import("node:fs");
		const wasmDir = join(import.meta.dirname, "..", "wasm");
		await initJpegEncode(await WebAssembly.compile(rf(join(wasmDir, "mozjpeg_enc.wasm"))));
		const width = 2000;
		const height = 1500;
		const data = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = Math.floor(Math.random() * 256);
			data[i + 1] = Math.floor(Math.random() * 256);
			data[i + 2] = Math.floor(Math.random() * 256);
			data[i + 3] = 255;
		}
		const encoded = await encodeJpeg({ width, height, data, colorSpace: "srgb" }, { quality: 90 });
		const original = Buffer.from(encoded);
		expect(original.byteLength).toBeGreaterThan(300 * 1024);
		writeFileSync(join(TEST_DIR, "big.jpg"), original);

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("read", { path: "big.jpg" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("downscaled");
		const embeddedBase64 = result.imageDataUrl!.split("base64,")[1]!;
		expect(Buffer.from(embeddedBase64, "base64").byteLength).toBeLessThan(original.byteLength);
	}, 90_000);
});

// ============================================================================
// write
// ============================================================================

describe("write", () => {
	it("rejects a missing or non-string content before touching the file", async () => {
		writeFileSync(join(TEST_DIR, "existing.txt"), "keep");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const missing = await exec("write", { path: "existing.txt" });
		const invalid = await exec("write", { path: "existing.txt", content: { text: "replace" } });
		expect(missing.isError).toBe(true);
		expect(invalid.isError).toBe(true);
		expect(readFileSync(join(TEST_DIR, "existing.txt"), "utf-8")).toBe("keep");
	});

	it("creates a file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "new.txt", content: "hello world" });
		expect(result.isError).toBeFalsy();

		const readResult = await exec("read", { path: "new.txt" });
		expect(readResult.content).toContain("hello world");
	});

	it("creates parent directories", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("write", { path: "deep/nested/file.txt", content: "ok" });
		const readResult = await exec("read", { path: "deep/nested/file.txt" });
		expect(readResult.content).toContain("ok");
	});

	it("reports the real UTF-8 byte count for non-ASCII content, not the JS string length", async () => {
		// content.length counts UTF-16 code units — for Cyrillic/CJK/emoji that
		// undercounts what writeFile's "utf-8" encoding actually puts on disk
		// (a 13-character Cyrillic+emoji string is 24 bytes on disk, not 13).
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const content = "привет мир 🎉";
		const result = await exec("write", { path: "unicode.txt", content });
		const onDiskBytes = statSync(join(TEST_DIR, "unicode.txt")).size;
		expect(onDiskBytes).toBe(Buffer.byteLength(content, "utf-8"));
		expect(result.content).toContain(`${onDiskBytes} bytes`);
		expect(result.content).not.toContain(`${content.length} bytes`);
	});

	it("rejects empty path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "", content: "data" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("path");
	});

	it("overwrites existing file", async () => {
		writeFileSync(join(TEST_DIR, "existing.txt"), "old");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("write", { path: "existing.txt", content: "new" });
		const readResult = await exec("read", { path: "existing.txt" });
		expect(readResult.content).toContain("new");
		expect(readResult.content).not.toContain("old");
	});

	it("reports a line diff when overwriting, not a byte count", async () => {
		writeFileSync(join(TEST_DIR, "diff.txt"), "alpha\nbeta\ngamma\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "diff.txt", content: "alpha\nBETA\ngamma\n" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("- beta");
		expect(result.content).toContain("+ BETA");
		expect(result.content).not.toContain("bytes to");
	});

	it("keeps the diff clean when only the trailing newline differs mid-rewrite", async () => {
		writeFileSync(join(TEST_DIR, "nl.txt"), "alpha\nbeta\ngamma\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		// Model rewrites with one changed line AND drops the trailing newline:
		// the diff must show only the changed line, with the newline as a note.
		const result = await exec("write", { path: "nl.txt", content: "alpha\nBETA\ngamma" });
		expect(result.content).toContain("- beta");
		expect(result.content).toContain("+ BETA");
		expect(result.content).not.toContain("- gamma");
		expect(result.content).toContain("trailing newline removed");
	});

	it("says the content was identical when nothing changed", async () => {
		writeFileSync(join(TEST_DIR, "same.txt"), "stable\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "same.txt", content: "stable\n" });
		expect(result.content).toContain("identical");
	});

	it("warns about consecutive identical lines in the written content", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", {
			path: "dup.txt",
			content: "# IDE state\n# IDE state\n.claude/\n",
		});
		expect(result.content).toContain("consecutive identical lines");
		expect(result.content).toContain("lines 1-2");
	});

	it("does not warn about consecutive blank lines", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: "blanks.txt", content: "a\n\n\nb\n" });
		expect(result.content).not.toContain("consecutive identical lines");
	});
});

// ============================================================================
// edit
// ============================================================================

describe("edit", () => {
	it("replaces a single occurrence of oldString", async () => {
		writeFileSync(join(TEST_DIR, "edit.txt"), "hello world\nfoo bar\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "edit.txt",
			oldString: "hello world",
			newString: "goodbye world",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "edit.txt"), "utf-8")).toBe("goodbye world\nfoo bar\n");
	});

	it("replaces a multi-line block", async () => {
		writeFileSync(join(TEST_DIR, "range.txt"), "alpha\nbeta\ngamma\ndelta\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "range.txt",
			oldString: "beta\ngamma",
			newString: "BETA-GAMMA",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "range.txt"), "utf-8")).toBe("alpha\nBETA-GAMMA\ndelta\n");
	});

	it("inserts new lines by including surrounding context in oldString", async () => {
		writeFileSync(join(TEST_DIR, "insert.txt"), "first\nthird\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "insert.txt",
			oldString: "first\nthird",
			newString: "first\nsecond\nthird",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "insert.txt"), "utf-8")).toBe("first\nsecond\nthird\n");
	});

	it("creates a new file when oldString is empty and the path doesn't exist", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "new-via-edit.txt",
			oldString: "",
			newString: "brand new content\n",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "new-via-edit.txt"), "utf-8")).toBe("brand new content\n");
	});

	it("rejects an empty oldString against an existing file", async () => {
		writeFileSync(join(TEST_DIR, "exists.txt"), "content\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "exists.txt",
			oldString: "",
			newString: "new\n",
		});
		expect(result.isError).toBe(true);
		expect(readFileSync(join(TEST_DIR, "exists.txt"), "utf-8")).toBe("content\n");
	});

	it("errors when oldString is not found", async () => {
		writeFileSync(join(TEST_DIR, "notfound.txt"), "alpha\nbeta\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "notfound.txt",
			oldString: "does not exist anywhere",
			newString: "x",
		});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/could not find/i);
	});

	it("errors when oldString matches more than once and replaceAll isn't set", async () => {
		writeFileSync(join(TEST_DIR, "dup.txt"), "x\ny\nx\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "dup.txt", oldString: "x", newString: "X" });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/multiple matches/i);
		expect(readFileSync(join(TEST_DIR, "dup.txt"), "utf-8")).toBe("x\ny\nx\n");
	});

	it("replaceAll replaces every occurrence", async () => {
		writeFileSync(join(TEST_DIR, "replall.txt"), "x\ny\nx\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "replall.txt",
			oldString: "x",
			newString: "X",
			replaceAll: true,
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "replall.txt"), "utf-8")).toBe("X\ny\nX\n");
	});

	it("errors when oldString equals newString", async () => {
		writeFileSync(join(TEST_DIR, "same.txt"), "x\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "same.txt", oldString: "x", newString: "x" });
		expect(result.isError).toBe(true);
	});

	it("matches despite a trailing-whitespace difference (line-trimmed fallback)", async () => {
		writeFileSync(join(TEST_DIR, "trailing-ws.txt"), "alpha  \nbeta\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "trailing-ws.txt", oldString: "alpha", newString: "ALPHA" });
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "trailing-ws.txt"), "utf-8")).toContain("ALPHA");
	});

	it("preserves indentation of the replacement block verbatim (tabs and spaces)", async () => {
		writeFileSync(join(TEST_DIR, "indent.txt"), "function f() {\n\tif (x) {\n\t}\n}\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", {
			filePath: "indent.txt",
			oldString: "\tif (x) {\n\t}",
			newString:
				"\tif (x) {\n\t\tconst y = 1;\n\t\tif (y) {\n\t\t\treturn y;\n\t\t}\n        // space-indented too\n\t}",
		});
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "indent.txt"), "utf-8")).toBe(
			"function f() {\n\tif (x) {\n\t\tconst y = 1;\n\t\tif (y) {\n\t\t\treturn y;\n\t\t}\n        // space-indented too\n\t}\n}\n",
		);
	});

	it("warns when an edit leaves consecutive identical lines behind", async () => {
		writeFileSync(join(TEST_DIR, "dupwarn.txt"), "one\ntwo\nthree\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "dupwarn.txt", oldString: "two", newString: "two\ntwo" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("consecutive identical lines");
	});

	it("shows a diff of what changed on success", async () => {
		writeFileSync(join(TEST_DIR, "echo.txt"), "l1\nl2\nl3\nl4\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "echo.txt", oldString: "l3", newString: "L3a\nL3b" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("- l3");
		expect(result.content).toContain("+ L3a");
		expect(result.content).toContain("+ L3b");
	});

	it("deletes text when newString removes it", async () => {
		writeFileSync(join(TEST_DIR, "delete.txt"), "a\nb\nc\nd\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "delete.txt", oldString: "b\nc\n", newString: "" });
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "delete.txt"), "utf-8")).toBe("a\nd\n");
	});

	it("errors on a missing file", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "nonexistent.txt", oldString: "x", newString: "y" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("File not found");
	});

	it("rejects empty filePath", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "", oldString: "a", newString: "b" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("filePath");
	});

	it("rejects missing oldString/newString", async () => {
		writeFileSync(join(TEST_DIR, "missing-args.txt"), "x\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "missing-args.txt" });
		expect(result.isError).toBe(true);
	});
});

// ============================================================================
// edit: CRLF line-ending preservation
// ============================================================================

describe("edit: CRLF line-ending preservation", () => {
	it("keeps CRLF consistent when replacing a single line", async () => {
		writeFileSync(join(TEST_DIR, "crlf1.txt"), "a\r\nb\r\nc\r\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("edit", { filePath: "crlf1.txt", oldString: "b", newString: "B" });
		expect(result.isError).toBeFalsy();
		expect(readFileSync(join(TEST_DIR, "crlf1.txt"), "utf-8")).toBe("a\r\nB\r\nc\r\n");
	});

	it("applies CRLF to every new line from a multi-line replace", async () => {
		writeFileSync(join(TEST_DIR, "crlf2.txt"), "a\r\nb\r\nc\r\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("edit", { filePath: "crlf2.txt", oldString: "b", newString: "B1\nB2\nB3" });
		expect(readFileSync(join(TEST_DIR, "crlf2.txt"), "utf-8")).toBe("a\r\nB1\r\nB2\r\nB3\r\nc\r\n");
	});

	it("does not double a \\r if the model's content already includes one", async () => {
		writeFileSync(join(TEST_DIR, "crlf5.txt"), "a\r\nb\r\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("edit", { filePath: "crlf5.txt", oldString: "b", newString: "B\r" });
		expect(readFileSync(join(TEST_DIR, "crlf5.txt"), "utf-8")).toBe("a\r\nB\r\n");
	});

	it("leaves an LF file's edits plain LF, and strips a stray \\r from model content", async () => {
		writeFileSync(join(TEST_DIR, "lf1.txt"), "a\nb\nc\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("edit", { filePath: "lf1.txt", oldString: "b", newString: "B\r" });
		expect(readFileSync(join(TEST_DIR, "lf1.txt"), "utf-8")).toBe("a\nB\nc\n");
	});
});

// ============================================================================
// glob
// ============================================================================

describe("glob", () => {
	it("rejects a missing pattern and a nonexistent directory", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const missingPattern = await exec("glob", {});
		const missingPath = await exec("glob", { pattern: "*.ts", path: "not-here" });
		expect(missingPattern.isError).toBe(true);
		expect(missingPath.isError).toBe(true);
		expect(missingPath.content).toContain("directory not found");
	});

	it("finds files by pattern", async () => {
		writeFileSync(join(TEST_DIR, "a.ts"), "");
		writeFileSync(join(TEST_DIR, "b.ts"), "");
		writeFileSync(join(TEST_DIR, "c.js"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.ts", path: TEST_DIR });
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.ts");
		expect(result.content).not.toContain("c.js");
		expect(result.content).toContain("call read on one of these paths");
	});

	it("accepts legacy find as an alias for glob", async () => {
		writeFileSync(join(TEST_DIR, "legacy.ts"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("find", { pattern: "legacy.ts", path: TEST_DIR });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("legacy.ts");
	});

	it("does not let a pattern break out and run injected shell commands", async () => {
		// pattern comes straight from a tool call argument — a single quote
		// used to break out of the execSync(`fd ... '${pattern}' ...`) string
		// and let the rest execute as a real shell command (confirmed
		// exploitable before this used execFileSync with an argument array).
		const canary = join(TEST_DIR, "injected.txt");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("glob", {
			pattern: `x'; touch '${canary}`,
			path: TEST_DIR,
		});
		expect(existsSync(canary)).toBe(false);
	});

	it("cancels a real in-flight fd process without falling back to a tree walk", async () => {
		const binDir = join(TEST_DIR, "slow-fd-bin");
		mkdirSync(binDir, { recursive: true });
		const fdPath = join(binDir, "fd");
		writeFileSync(fdPath, "#!/bin/sh\nexec /bin/sleep 30\n");
		chmodSync(fdPath, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		const controller = new AbortController();
		const exec = createToolExecutor(TEST_DIR, mockConfig);

		try {
			const start = Date.now();
			const resultPromise = exec("glob", { pattern: "*.ts", path: TEST_DIR }, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			const result = await resultPromise;

			expect(Date.now() - start).toBeLessThan(5000);
			expect(result).toMatchObject({ isError: true, error: { code: "ABORTED", retryable: false } });
			expect(result.content).toContain("[ABORTED]");
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

// ============================================================================
// glob: ** / directory-component patterns, and fd vs. no-fd fallback parity
// ============================================================================
//
// fd only matches a pattern against the full path when --full-path is passed;
// without it, matching is basename-only, so a pattern containing "/" (like
// `src/**/*.ts` or `**/tools/*.ts`) would silently match nothing. The no-fd
// fallback walks the tree in JS and must mirror this exactly, or the two code
// paths return different results for the same pattern depending on whether
// fd happens to be installed.

/** Runs fn with PATH pointing at an empty directory, so `execFile("fd", ...)`
 * and `execFile("rg", ...)` fail with ENOENT and glob/grep fall back to the
 * pure-JS tree walk — without actually needing fd/rg absent on the host. */
async function withoutFdOnPath<T>(fn: () => Promise<T>): Promise<T> {
	const emptyPathDir = join(TEST_DIR, "__empty_path__");
	mkdirSync(emptyPathDir, { recursive: true });
	const originalPath = process.env.PATH;
	process.env.PATH = emptyPathDir;
	try {
		return await fn();
	} finally {
		process.env.PATH = originalPath;
	}
}

// Same mechanism as withoutFdOnPath — an empty PATH hides rg too — named
// separately at grep call sites purely for readability.
const withoutRgOnPath = withoutFdOnPath;

// Nested tree lives under NESTED_ROOT rather than directly in TEST_DIR:
// TEST_DIR's own basename is "tools" (see TEST_DIR above), which would make
// a `**/tools/*.ts` pattern match the search root itself, not just the
// nested src/core/tools/ directory the test is trying to isolate.
const NESTED_ROOT = join(TEST_DIR, "proj");

function buildNestedTree() {
	mkdirSync(join(NESTED_ROOT, "src", "core", "tools"), { recursive: true });
	mkdirSync(join(NESTED_ROOT, "src", "ui"), { recursive: true });
	mkdirSync(join(NESTED_ROOT, "test"), { recursive: true });
	writeFileSync(join(NESTED_ROOT, "src", "core", "tools", "search.ts"), "");
	writeFileSync(join(NESTED_ROOT, "src", "core", "tools", "files.ts"), "");
	writeFileSync(join(NESTED_ROOT, "src", "ui", "App.tsx"), "");
	writeFileSync(join(NESTED_ROOT, "test", "tools.test.ts"), "");
	writeFileSync(join(NESTED_ROOT, "top-level.ts"), "");
}

describe("glob: ** and directory-component patterns (fd path)", () => {
	it("`**/*.ts` recurses into subdirectories", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await exec("glob", { pattern: "**/*.ts", path: NESTED_ROOT });
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).toContain("top-level.ts");
		expect(result.content).not.toContain("App.tsx");
	});

	it("`src/**/*.ts` (leading literal directory + **) matches nested files", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await exec("glob", { pattern: "src/**/*.ts", path: NESTED_ROOT });
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("`**/tools/*.ts` (directory literal in the middle) matches", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await exec("glob", { pattern: "**/tools/*.ts", path: NESTED_ROOT });
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("App.tsx");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("a fully literal directory path with a trailing wildcard matches", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await exec("glob", { pattern: "src/core/tools/*.ts", path: NESTED_ROOT });
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("a slash-free pattern still matches by basename only (unaffected by the fix)", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await exec("glob", { pattern: "*.ts", path: NESTED_ROOT });
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).toContain("top-level.ts");
		expect(result.content).toContain("test/tools.test.ts");
	});
});

describe("glob: no-fd fallback parity", () => {
	it("falls back to the JS tree walk when fd is not on PATH", async () => {
		mkdirSync(NESTED_ROOT, { recursive: true });
		writeFileSync(join(NESTED_ROOT, "a.ts"), "");
		writeFileSync(join(NESTED_ROOT, "b.js"), "");
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await withoutFdOnPath(() => exec("glob", { pattern: "*.ts", path: NESTED_ROOT }));
		expect(result.content).toContain("a.ts");
		expect(result.content).not.toContain("b.js");
	});

	it("`**/*.ts` recurses into subdirectories without fd", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await withoutFdOnPath(() => exec("glob", { pattern: "**/*.ts", path: NESTED_ROOT }));
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).toContain("top-level.ts");
		expect(result.content).not.toContain("App.tsx");
	});

	it("`src/**/*.ts` matches nested files without fd", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await withoutFdOnPath(() => exec("glob", { pattern: "src/**/*.ts", path: NESTED_ROOT }));
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("`**/tools/*.ts` matches a directory literal in the middle without fd", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await withoutFdOnPath(() => exec("glob", { pattern: "**/tools/*.ts", path: NESTED_ROOT }));
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("App.tsx");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("a fully literal directory path with a trailing wildcard matches without fd", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const result = await withoutFdOnPath(() => exec("glob", { pattern: "src/core/tools/*.ts", path: NESTED_ROOT }));
		expect(result.content).toContain("src/core/tools/search.ts");
		expect(result.content).toContain("src/core/tools/files.ts");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("produces the same matched file set with and without fd", async () => {
		buildNestedTree();
		const exec = createToolExecutor(NESTED_ROOT, mockConfig);
		const patterns = ["*.ts", "**/*.ts", "src/**/*.ts", "**/tools/*.ts", "src/core/tools/*.ts"];

		for (const pattern of patterns) {
			const withFd = await exec("glob", { pattern, path: NESTED_ROOT });
			const withoutFd = await withoutFdOnPath(() => exec("glob", { pattern, path: NESTED_ROOT }));

			const normalize = (content: string) =>
				content
					.split("\n")
					.filter((line) => !line.startsWith("[note:"))
					.sort();

			expect(normalize(withoutFd.content)).toEqual(normalize(withFd.content));
		}
	});
});

// ============================================================================
// grep
// ============================================================================

describe("grep", () => {
	it("rejects a missing pattern and a nonexistent search path", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const missingPattern = await exec("grep", {});
		const missingPath = await exec("grep", { pattern: "needle", path: "not-here" });
		expect(missingPattern.isError).toBe(true);
		expect(missingPath.isError).toBe(true);
		expect(missingPath.content).toContain("path not found");
	});

	it("finds matching lines", async () => {
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\nfoo bar\nhello again\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "hello", path: TEST_DIR });
		expect(result.content).toContain("hello world");
		expect(result.content).toContain("hello again");
		expect(result.content).not.toContain("foo bar");
	});

	it("cancels a real in-flight rg process without falling back to a content scan", async () => {
		const binDir = join(TEST_DIR, "slow-rg-bin");
		mkdirSync(binDir, { recursive: true });
		const rgPath = join(binDir, "rg");
		writeFileSync(rgPath, "#!/bin/sh\nexec /bin/sleep 30\n");
		chmodSync(rgPath, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		const controller = new AbortController();
		const exec = createToolExecutor(TEST_DIR, mockConfig);

		try {
			const start = Date.now();
			const resultPromise = exec("grep", { pattern: "needle", path: TEST_DIR }, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			const result = await resultPromise;

			expect(Date.now() - start).toBeLessThan(5000);
			expect(result).toMatchObject({ isError: true, error: { code: "ABORTED", retryable: false } });
			expect(result.content).toContain("[ABORTED]");
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("does not let a pattern break out and run injected shell commands", async () => {
		const canary = join(TEST_DIR, "injected.txt");
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("grep", {
			pattern: `x'; touch '${canary}`,
			path: TEST_DIR,
		});
		expect(existsSync(canary)).toBe(false);
	});

	it("does not let glob break out and run injected shell commands", async () => {
		const canary = join(TEST_DIR, "injected.txt");
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("grep", {
			pattern: "hello",
			path: TEST_DIR,
			glob: `*'; touch '${canary}`,
		});
		expect(existsSync(canary)).toBe(false);
	});

	it("returns 'No matches found' for a pattern that matches nothing (rg exit 1)", async () => {
		writeFileSync(join(TEST_DIR, "grep.txt"), "hello world\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "zzz_definitely_absent_zzz", path: TEST_DIR });
		expect(result.content).toBe("No matches found");
		expect(result.isError).toBeUndefined();
	});

	it("finds a match when path names a single file, not a directory (rg path)", async () => {
		writeFileSync(join(TEST_DIR, "single.txt"), "INFO startup\nERROR disk full\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "error", path: join(TEST_DIR, "single.txt"), ignoreCase: true });
		expect(result.content).toContain("ERROR disk full");
	});

	it("finds a match when path names a single file, not a directory (fallback)", async () => {
		// walkFiles assumes a directory (readdir) — a single-file searchPath
		// used to hit ENOTDIR, get swallowed, and silently report zero matches.
		writeFileSync(join(TEST_DIR, "single.txt"), "INFO startup\nERROR disk full\n");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await withoutRgOnPath(() =>
			exec("grep", { pattern: "error", path: join(TEST_DIR, "single.txt"), ignoreCase: true }),
		);
		expect(result.content).toContain("ERROR disk full");
	});

	function buildGrepDirTree(root: string) {
		mkdirSync(join(root, "src", "core", "tools"), { recursive: true });
		mkdirSync(join(root, "src", "ui"), { recursive: true });
		writeFileSync(join(root, "src", "core", "tools", "search.ts"), "needle here\n");
		writeFileSync(join(root, "src", "ui", "App.tsx"), "needle here\n");
		writeFileSync(join(root, "top-level.ts"), "needle here\n");
	}

	it("`--glob` with a directory component only matches under that directory (rg path)", async () => {
		buildGrepDirTree(TEST_DIR);
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("grep", { pattern: "needle", path: TEST_DIR, glob: "src/core/tools/*.ts" });
		expect(result.content).toContain("search.ts");
		expect(result.content).not.toContain("App.tsx");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("`--glob` with a directory component matches the same files without rg (fallback)", async () => {
		buildGrepDirTree(TEST_DIR);
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await withoutRgOnPath(() =>
			exec("grep", { pattern: "needle", path: TEST_DIR, glob: "src/core/tools/*.ts" }),
		);
		expect(result.content).toContain("search.ts");
		expect(result.content).not.toContain("App.tsx");
		expect(result.content).not.toContain("top-level.ts");
	});

	it("produces the same matched file set for a directory-component --glob with and without rg", async () => {
		buildGrepDirTree(TEST_DIR);
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const globs = ["*.ts", "src/core/tools/*.ts", "**/tools/*.ts"];

		for (const glob of globs) {
			const withRg = await exec("grep", { pattern: "needle", path: TEST_DIR, glob });
			const withoutRg = await withoutRgOnPath(() => exec("grep", { pattern: "needle", path: TEST_DIR, glob }));

			const filesOf = (content: string) =>
				content
					.split("\n")
					.map((line) => line.split(":")[0])
					.filter(Boolean)
					.sort();

			expect(filesOf(withoutRg.content)).toEqual(filesOf(withRg.content));
		}
	});
});

describe("grep permission diagnostics", () => {
	it("isPermissionError recognizes EPERM/EACCES but not ENOENT", () => {
		expect(isPermissionError({ code: "EPERM" })).toBe(true);
		expect(isPermissionError({ code: "EACCES" })).toBe(true);
		expect(isPermissionError({ code: "ENOENT" })).toBe(false);
		expect(isPermissionError(new Error("nope"))).toBe(false);
		expect(isPermissionError(undefined)).toBe(false);
	});

	it("withAccessNote appends a note when the fallback skipped paths for permissions", () => {
		const out = withAccessNote("src/a.ts:1:hit", "", 2);
		expect(out).toContain("src/a.ts:1:hit");
		expect(out).toContain("2 path(s) skipped");
		expect(out).toContain("Full Disk Access");
	});

	it("withAccessNote appends a note when rg's stderr reported permission denied", () => {
		const out = withAccessNote("No matches found", "rg: /Users/x/Documents: Operation not permitted (os error 1)", 0);
		expect(out).toContain("No matches found");
		expect(out).toContain("skipped — permission denied");
	});

	it("withAccessNote is a no-op when nothing was blocked", () => {
		expect(withAccessNote("clean output", "", 0)).toBe("clean output");
	});
});

// ============================================================================
// brace expansion in glob patterns
// ============================================================================

describe("brace expansion", () => {
	it("expands {a,b} to match alternatives", async () => {
		writeFileSync(join(TEST_DIR, "a.ts"), "");
		writeFileSync(join(TEST_DIR, "b.js"), "");
		writeFileSync(join(TEST_DIR, "c.css"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.{ts,js}", path: TEST_DIR });
		expect(result.content).toContain("a.ts");
		expect(result.content).toContain("b.js");
		expect(result.content).not.toContain("c.css");
	});

	it("expands {a,b,c} with three alternatives", async () => {
		writeFileSync(join(TEST_DIR, "x.ts"), "");
		writeFileSync(join(TEST_DIR, "y.js"), "");
		writeFileSync(join(TEST_DIR, "z.css"), "");
		writeFileSync(join(TEST_DIR, "w.md"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.{ts,js,md}", path: TEST_DIR });
		expect(result.content).toContain("x.ts");
		expect(result.content).toContain("y.js");
		expect(result.content).toContain("w.md");
		expect(result.content).not.toContain("z.css");
	});

	it("handles nested globs inside braces", async () => {
		writeFileSync(join(TEST_DIR, "test.spec.ts"), "");
		writeFileSync(join(TEST_DIR, "test.test.ts"), "");
		writeFileSync(join(TEST_DIR, "bare.ts"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.{spec,test}.ts", path: TEST_DIR });
		expect(result.content).toContain("test.spec.ts");
		expect(result.content).toContain("test.test.ts");
		expect(result.content).not.toContain("bare.ts");
	});

	it("treats unmatched { as literal", async () => {
		writeFileSync(join(TEST_DIR, "a{b"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "a{b", path: TEST_DIR });
		expect(result.content).toContain("a{b");
	});
});

// ============================================================================
// symlink cycle detection
// ============================================================================

describe("symlink cycle detection", () => {
	it("does not loop on circular symlinks", async () => {
		const dirA = join(TEST_DIR, "a");
		const dirB = join(dirA, "b");
		mkdirSync(dirB, { recursive: true });
		writeFileSync(join(dirA, "file.txt"), "");
		// dirA/b/link -> dirA (cycle!)
		symlinkSync(dirA, join(dirB, "link"));

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		// Should complete without hanging
		const result = await exec("glob", { pattern: "*.txt", path: TEST_DIR, timeout: 5 });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("file.txt");
	});

	it("follows symlinks but does not revisit targets", async () => {
		const realDir = join(TEST_DIR, "real");
		const linkDir = join(TEST_DIR, "link");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "data.txt"), "");
		symlinkSync(realDir, linkDir);

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "data.txt", path: TEST_DIR });
		// Should find data.txt once (via real/ or link/), not loop
		expect(result.content).toContain("data.txt");
	});

	it("handles self-referencing symlink", async () => {
		const selfDir = join(TEST_DIR, "self");
		mkdirSync(selfDir);
		writeFileSync(join(selfDir, "ok.txt"), "");
		symlinkSync(selfDir, join(selfDir, "loop"));

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "ok.txt", path: TEST_DIR, timeout: 5 });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("ok.txt");
	});
});

// ============================================================================
// gitignore: negation and nested .gitignore
// ============================================================================

describe("gitignore negation", () => {
	it("ignores files matching a pattern", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log");
		writeFileSync(join(TEST_DIR, "app.log"), "");
		writeFileSync(join(TEST_DIR, "app.ts"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).not.toContain("app.log");
	});

	it("un-ignores files with negation pattern", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log\n!important.log");
		writeFileSync(join(TEST_DIR, "debug.log"), "");
		writeFileSync(join(TEST_DIR, "important.log"), "");
		writeFileSync(join(TEST_DIR, "app.ts"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).toContain("important.log");
		expect(result.content).not.toContain("debug.log");
	});

	it("last matching rule wins", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.txt\n!important.txt\n*.txt");
		writeFileSync(join(TEST_DIR, "file.txt"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.txt", path: TEST_DIR });
		expect(result.content).not.toContain("file.txt");
	});
});

describe("nested .gitignore", () => {
	it("applies rules from nested .gitignore in subdirectories", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src", ".gitignore"), "*.tmp");
		writeFileSync(join(TEST_DIR, "src", "app.ts"), "");
		writeFileSync(join(TEST_DIR, "src", "cache.tmp"), "");
		writeFileSync(join(TEST_DIR, "root.tmp"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*.tmp", path: TEST_DIR });
		// src/.gitignore ignores *.tmp only under src/
		expect(result.content).toContain("root.tmp");
		expect(result.content).not.toContain("cache.tmp");
	});

	it("inherits parent rules and adds nested rules", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "*.log");
		mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
		writeFileSync(join(TEST_DIR, "sub", ".gitignore"), "*.tmp");
		writeFileSync(join(TEST_DIR, "sub", "app.ts"), "");
		writeFileSync(join(TEST_DIR, "sub", "debug.log"), "");
		writeFileSync(join(TEST_DIR, "sub", "cache.tmp"), "");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("glob", { pattern: "*", path: TEST_DIR });
		expect(result.content).toContain("app.ts");
		expect(result.content).not.toContain("debug.log"); // root rule
		expect(result.content).not.toContain("cache.tmp"); // nested rule
	});
});

// ============================================================================
// ls
// ============================================================================

describe("ls", () => {
	it("rejects an invalid limit instead of silently slicing entries", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { limit: -1 });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('"limit" must be a positive integer');
	});

	it("lists directory contents", async () => {
		writeFileSync(join(TEST_DIR, "file1.txt"), "");
		writeFileSync(join(TEST_DIR, "file2.txt"), "");
		mkdirSync(join(TEST_DIR, "subdir"));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: TEST_DIR });
		expect(result.content).toContain("file1.txt");
		expect(result.content).toContain("file2.txt");
		expect(result.content).toContain("subdir/");
	});

	it("classifies a symlink pointing at a directory as a directory, not a file", async () => {
		// entry.isDirectory() reflects the symlink itself (false), not its
		// target — without following it, this used to print the linked
		// directory as a "file" with the target inode's meaningless "size"
		// and no trailing slash.
		const realDir = join(TEST_DIR, "real");
		mkdirSync(realDir);
		symlinkSync(realDir, join(TEST_DIR, "linkdir"));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: TEST_DIR });
		const line = result.content.split("\n").find((l) => l.includes("linkdir"));
		expect(line).toContain("linkdir/");
		expect(line?.trimStart().startsWith("d")).toBe(true);
	});

	it("still classifies a symlink pointing at a file as a file", async () => {
		writeFileSync(join(TEST_DIR, "real.txt"), "hi");
		symlinkSync(join(TEST_DIR, "real.txt"), join(TEST_DIR, "linkfile"));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: TEST_DIR });
		const line = result.content.split("\n").find((l) => l.includes("linkfile"));
		expect(line).not.toContain("linkfile/");
		expect(line?.trimStart().startsWith("f")).toBe(true);
	});

	it("does not throw on a broken symlink", async () => {
		symlinkSync(join(TEST_DIR, "does-not-exist"), join(TEST_DIR, "broken-link"));
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: TEST_DIR });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("broken-link");
	});

	it("reports a friendly error for a missing directory instead of a raw ENOENT", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: join(TEST_DIR, "does-not-exist") });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Directory not found");
		expect(result.content).not.toContain("ENOENT");
		expect(result.content).not.toContain("scandir");
	});

	it("reports a friendly error when the path is a file instead of a raw ENOTDIR", async () => {
		writeFileSync(join(TEST_DIR, "notadir.txt"), "");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("ls", { path: join(TEST_DIR, "notadir.txt") });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Not a directory");
		expect(result.content).not.toContain("ENOTDIR");
	});
});

// ============================================================================
// unknown tool
// ============================================================================

describe("unknown tool", () => {
	it("returns error for unknown tool", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("nonexistent", {});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});

// ============================================================================
// task
// ============================================================================

describe("task", () => {
	it("returns error when taskDeps not configured", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("task", { assignment: "do something" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not available");
	});

	it("returns error for missing assignment", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [],
			runAgentLoop: async () => {
				throw new Error("should not be called");
			},
		});
		const result = await exec("task", {});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Missing");
	});

	it("returns error for unknown subagent", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [
				{
					name: "worker",
					label: "Worker",
					description: "test",
					systemPrompt: "test",
				},
			],
			runAgentLoop: async () => {
				throw new Error("should not be called");
			},
		});
		const result = await exec("task", { assignment: "do something", subagent: "nonexistent" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown subagent");
	});

	it("child loop receives no personas — cannot delegate further", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [
				{
					name: "worker",
					label: "Worker",
					description: "test",
					systemPrompt: "worker prompt",
					agentsMd: false,
				},
			],
			runAgentLoop: async (_msgs, config) => {
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "test task" });
		expect(capturedConfig?.personas).toBeUndefined();
		expect(capturedConfig?.currentPersona).toBeUndefined();
		expect(capturedConfig?.subagentPrompts).toBeUndefined();
		expect(capturedConfig?.subagentModel).toBeUndefined();
	});

	it("defaults to the 'worker' subagent even when another sorts earlier", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			// "analyst" sorts before "worker"; the default must still be worker.
			subagentPrompts: [
				{ name: "analyst", label: "Analyst", description: "x", systemPrompt: "analyst prompt", agentsMd: false },
				{ name: "worker", label: "Worker", description: "x", systemPrompt: "worker prompt", agentsMd: false },
			],
			runAgentLoop: async (_msgs, config) => {
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "do it" }); // no persona → default
		expect(String(capturedConfig?.systemPrompt)).toContain("worker prompt");
		expect(String(capturedConfig?.systemPrompt)).toContain("Current working directory:");
	});

	it("passes the assignment only in the user message, not the system prompt", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		let capturedMessages: unknown;
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt", agentsMd: false },
			],
			runAgentLoop: async (msgs, config) => {
				capturedMessages = msgs;
				capturedConfig = config as Record<string, unknown>;
				return [{ role: "assistant", content: "done" }];
			},
		});
		await exec("task", { assignment: "unique-assignment-token" });
		expect(String(capturedConfig?.systemPrompt)).toContain("worker prompt");
		expect(String(capturedConfig?.systemPrompt)).not.toContain("unique-assignment-token");
		expect(JSON.stringify(capturedMessages)).toContain("unique-assignment-token");
	});

	it("surfaces a non-stop end reason as an error", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({ type: "end", reason: "aborted" });
				return [{ role: "assistant", content: "partial" }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("aborted");
		expect(result.content).toContain("partial");
	});

	it("propagates provider-reported subagent cost in subagentUsage", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({
					type: "usage",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.002 },
				});
				config.onEvent?.({
					type: "usage",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28, cost: 0.003 },
				});
				config.onEvent?.({ type: "end", reason: "stop" });
				return [{ role: "assistant", content: "done" }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBeFalsy();
		expect(result.subagentUsage?.cost).toBeCloseTo(0.005);
	});

	it("flags an empty result as an error even when the run finished", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async (_msgs, config) => {
				config.onEvent?.({ type: "end", reason: "stop" });
				return [{ role: "assistant", content: "   " }];
			},
		});
		const result = await exec("task", { assignment: "do it" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no output");
	});

	it("caps concurrent subagents at 10", async () => {
		let active = 0;
		let peak = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			runAgentLoop: async () => {
				active++;
				peak = Math.max(peak, active);
				await gate;
				active--;
				return [{ role: "assistant", content: "done" }];
			},
		});
		const runs = Array.from({ length: 25 }, () => exec("task", { assignment: "work" }));
		// Let the semaphore admit its first wave before releasing the gate.
		await new Promise((r) => setTimeout(r, 20));
		expect(peak).toBe(10);
		release();
		await Promise.all(runs);
		expect(peak).toBe(10);
	});

	it("cancels queued subagents immediately when the signal aborts (no slot wait)", async () => {
		const ac = new AbortController();
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "x", systemPrompt: "worker prompt" }],
			runAgentLoop: async () => {
				started++;
				await gate; // the 10 admitted runs park here, holding every slot
				return [{ role: "assistant", content: "done" }];
			},
		});
		// 10 fill the cap and block; 3 more queue behind the semaphore.
		const runs = Array.from({ length: 13 }, () => exec("task", { assignment: "work" }, ac.signal));
		await new Promise((r) => setTimeout(r, 20));
		expect(started).toBe(10); // only the cap started; 3 are queued

		ac.abort();
		const results = await Promise.all(runs.slice(10)); // the 3 queued ones
		// They resolve right away as aborted errors, without waiting for a slot.
		for (const r of results) {
			expect(r.isError).toBe(true);
			expect(r.content).toContain("aborted");
		}
		expect(started).toBe(10); // none of the queued runs ever entered the loop

		release();
		await Promise.all(runs.slice(0, 10));
	});

	it("serializes confirmBash across concurrent subagents", async () => {
		let confirmActive = 0;
		let confirmPeak = 0;
		const confirm = async (): Promise<boolean> => {
			confirmActive++;
			confirmPeak = Math.max(confirmPeak, confirmActive);
			await new Promise((r) => setTimeout(r, 10));
			confirmActive--;
			return true;
		};
		const exec = createToolExecutor(TEST_DIR, mockConfig, confirm, {
			model: "test",
			subagentPrompts: [{ name: "worker", label: "Worker", description: "test", systemPrompt: "worker prompt" }],
			confirmBash: confirm,
			runAgentLoop: async (_msgs, config) => {
				// The child invokes the (wrapped) confirmBash it was handed.
				await config.confirmBash?.("rm -rf x", "dangerous");
				return [{ role: "assistant", content: "done" }];
			},
		});
		const runs = Array.from({ length: 5 }, () => exec("task", { assignment: "work" }));
		await Promise.all(runs);
		expect(confirmPeak).toBe(1);
	});
});

// ============================================================================
// plan tools — executor dispatch and definition invariants
// ============================================================================

describe("plan tools dispatch", () => {
	function planStateInTestDir(): PlanState {
		return { enabled: true, plansDir: join(TEST_DIR, "plans") };
	}

	it("returns 'not available' for every plan tool when no planState is wired (headless, subagents)", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		for (const name of PLAN_TOOL_NAMES) {
			const result = await exec(name, { name: "x", content: "# P", item: "x", reason: "r" });
			expect(result.isError, `${name} must be unavailable without planState`).toBe(true);
			expect(result.content).toContain("not available");
		}
	});

	it("routes the full lifecycle through the real executors when planState is wired", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);

		// Plan authoring goes through the ordinary write/edit tools, gated to
		// the plan file's path — see plan.ts's file doc comment.
		const planPath = join(TEST_DIR, "plans", "lifecycle.md");
		const write = await exec("write", { path: planPath, content: "# P\n\n## Steps\n- [ ] only step" });
		expect(write.isError).toBeFalsy();
		expect(existsSync(planPath)).toBe(true);

		// A plain `read` of the plan file confirms it's readable and (via
		// maybeActivatePlanOnRead) stays the active plan — no plan_read tool.
		const read = await exec("read", { path: planPath });
		expect(read.isError).toBeFalsy();
		expect(read.content).toContain("only step");

		const done = JSON.parse((await exec("plan_done", { summary: "s" })).content);
		expect(done.planReady).toBe(true);

		const question = JSON.parse(
			(
				await exec("question", {
					questions: [
						{
							question: "Choose cache backend",
							options: [
								{ value: "memory", label: "In-memory" },
								{ value: "redis", label: "Redis" },
							],
						},
					],
				})
			).content,
		);
		expect(question.question).toBe(true);
	});

	it("write/edit reach the real code tree normally when plan mode is off", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, {
			enabled: false,
			plansDir: join(TEST_DIR, "plans"),
		});
		const result = await exec("write", { path: join(TEST_DIR, "real-file.ts"), content: "export const x = 1;\n" });
		expect(result.isError).toBeFalsy();
		expect(existsSync(join(TEST_DIR, "real-file.ts"))).toBe(true);
	});

	it("blocks write/edit outside the plans directory while plan mode is active", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);

		const result = await exec("write", { path: join(TEST_DIR, "real-file.ts"), content: "export const x = 1;\n" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain(planState.plansDir);
		expect(existsSync(join(TEST_DIR, "real-file.ts"))).toBe(false);
	});

	it("blocks a non-.md file even inside the plans directory", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);

		const result = await exec("write", { path: join(planState.plansDir, "notes.txt"), content: "hi" });
		expect(result.isError).toBe(true);
	});

	it("rejects a write over MAX_PLAN_CHARS before touching disk", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);
		const planPath = join(planState.plansDir, "huge.md");

		const result = await exec("write", { path: planPath, content: "y".repeat(MAX_PLAN_CHARS + 1) });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("limit is");
		expect(existsSync(planPath)).toBe(false);
	});

	it("rolls back an edit that would grow the plan past MAX_PLAN_CHARS", async () => {
		const planState = planStateInTestDir();
		const exec = createToolExecutor(TEST_DIR, mockConfig, undefined, undefined, planState);
		const planPath = join(planState.plansDir, "grows.md");

		await exec("write", { path: planPath, content: "# Plan\n\n## Steps\n- [ ] x" });

		const result = await exec("edit", {
			filePath: planPath,
			oldString: "- [ ] x",
			newString: `- [ ] ${"y".repeat(MAX_PLAN_CHARS + 1)}`,
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("limit is");
		expect(readFileSync(planPath, "utf-8")).toBe("# Plan\n\n## Steps\n- [ ] x");
	});

	it("write/edit on the plan path stay unaffected when planState is undefined (no plan mode configured at all)", async () => {
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const result = await exec("write", { path: join(TEST_DIR, "anything.md"), content: "hi" });
		expect(result.isError).toBeFalsy();
	});
});

describe("plan tool definitions", () => {
	it("every plan_* definition is gated by PLAN_TOOL_NAMES — and vice versa", () => {
		// PLAN_TOOL_NAMES drives the headless and subagent disable lists; a
		// plan tool defined but missing from it would leak into contexts that
		// have no plan mode at all.
		const defined = getToolDefinitions()
			.map((t) => t.function.name)
			.filter((n) => n.startsWith("plan_"));
		expect([...defined].sort()).toEqual([...PLAN_TOOL_NAMES].sort());
	});
});
