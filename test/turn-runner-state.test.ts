import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module writes sentinel files to `${homedir()}/.cast/sessions/` — fake
// HOME for the whole file so a leaked/aborted test can never pollute the real
// ~/.cast (a stale .running-*.json landed there once from a killed run).
let realHome: string | undefined;
let fakeHome: string;
let markTurnRunner!: typeof import("../src/core/turn-runner-state.ts").markTurnRunner;
let clearTurnRunner!: typeof import("../src/core/turn-runner-state.ts").clearTurnRunner;
let effectiveStatusFromFile!: typeof import("../src/core/turn-runner-state.ts").effectiveStatusFromFile;
let isProcessAlive!: typeof import("../src/core/turn-runner-state.ts").isProcessAlive;
let acquireTurnRunner!: typeof import("../src/core/turn-runner-state.ts").acquireTurnRunner;
let releaseTurnRunner!: typeof import("../src/core/turn-runner-state.ts").releaseTurnRunner;

beforeEach(async () => {
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "cast-turn-runner-test-"));
	process.env.HOME = fakeHome;
	mkdirSync(join(fakeHome, ".cast", "sessions"), { recursive: true });
	// STATE_DIR is captured from homedir() at import time — re-import against
	// the temp HOME so the module writes where these tests read.
	vi.resetModules();
	const mod = await import("../src/core/turn-runner-state.ts");
	({ markTurnRunner, clearTurnRunner, effectiveStatusFromFile, isProcessAlive, acquireTurnRunner, releaseTurnRunner } =
		mod);
});
afterEach(() => {
	process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

/** Path helper — the module writes to `${homedir()}/.cast/sessions/.running-${id}.json`. */
function pathFor(id: string): string {
	return join(homedir(), ".cast", "sessions", `.running-${id}.json`);
}

const TEST_ID = "abc-123-def";

describe("turn-runner-state", () => {
	it("isProcessAlive detects live and dead PIDs", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(999999)).toBe(false);
	});

	it("markTurnRunner writes a file readable by effectiveStatusFromFile", () => {
		markTurnRunner(TEST_ID, process.pid);
		try {
			expect(effectiveStatusFromFile(TEST_ID)).toBe("running");
		} finally {
			clearTurnRunner(TEST_ID, process.pid);
		}
	});

	it("clearTurnRunner removes the file when pid matches", () => {
		markTurnRunner(TEST_ID, process.pid);
		expect(effectiveStatusFromFile(TEST_ID)).toBe("running");
		clearTurnRunner(TEST_ID, process.pid);
		expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
	});

	it("clearTurnRunner does NOT remove a file written by another pid", () => {
		markTurnRunner(TEST_ID, process.pid);
		// Simulate another TUI's clean-up pass — should leave the file alone.
		clearTurnRunner(TEST_ID, 999999);
		expect(effectiveStatusFromFile(TEST_ID)).toBe("running");
		// Now we clean up correctly with our real pid.
		clearTurnRunner(TEST_ID, process.pid);
		expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
	});

	it("effectiveStatusFromFile returns idle when no file exists", () => {
		expect(effectiveStatusFromFile("nonexistent-session-id-xyz")).toBe("idle");
	});

	it("effectiveStatusFromFile returns idle when file is malformed", () => {
		const path = pathFor(TEST_ID);
		writeFileSync(path, "not json {{{", "utf-8");
		expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
	});

	it("effectiveStatusFromFile returns idle when pid is dead", () => {
		const path = pathFor(TEST_ID);
		writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: Date.now() }), "utf-8");
		expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
	});

	it("effectiveStatusFromFile returns idle when file is past stale threshold", () => {
		const path = pathFor(TEST_ID);
		const oldEnough = Date.now() - 61_000; // > STALE_THRESHOLD_MS (60s)
		writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: oldEnough }), "utf-8");
		expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
	});

	it("end-to-end: mark → file exists with correct content → clear → file gone", () => {
		const path = pathFor(TEST_ID);
		markTurnRunner(TEST_ID, process.pid);
		expect(existsSync(path)).toBe(true);
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		expect(raw.pid).toBe(process.pid);
		expect(typeof raw.startedAt).toBe("number");

		clearTurnRunner(TEST_ID, process.pid);
		expect(existsSync(path)).toBe(false);
	});

	it("writes to correct path under homedir().cast/sessions", () => {
		markTurnRunner(TEST_ID, process.pid);
		try {
			const expected = pathFor(TEST_ID);
			expect(existsSync(expected)).toBe(true);
			const content = JSON.parse(readFileSync(expected, "utf-8"));
			expect(content.pid).toBe(process.pid);
		} finally {
			clearTurnRunner(TEST_ID, process.pid);
		}
	});

	it("allows only one process to acquire a session turn lock", () => {
		expect(acquireTurnRunner(TEST_ID, process.pid)).toBe(true);
		try {
			expect(acquireTurnRunner(TEST_ID, process.pid)).toBe(false);
		} finally {
			releaseTurnRunner(TEST_ID, process.pid);
		}
		expect(acquireTurnRunner(TEST_ID, process.pid)).toBe(true);
		releaseTurnRunner(TEST_ID, process.pid);
	});
});

// =============================================================================
// Real-process-death test: spawn a long-running child, write a marker for
// its pid, kill it, then verify effectiveStatusFromFile returns "idle".
// This is the actual scenario the feature exists for — TUI crashes during
// a turn, web UI needs to clean up.
// =============================================================================
describe("turn-runner-state with real child process", () => {
	it("returns idle after the recorded process is killed", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000);"]);
		const childPid = child.pid!;
		expect(childPid).toBeGreaterThan(0);

		try {
			markTurnRunner(TEST_ID, childPid);

			// While alive: status should be "running".
			expect(isProcessAlive(childPid)).toBe(true);
			expect(effectiveStatusFromFile(TEST_ID)).toBe("running");

			// Kill it.
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				child.on("exit", () => resolve());
			});

			// Now the recorded pid is dead. Even though the file still exists,
			// the predicate must self-heal.
			expect(isProcessAlive(childPid)).toBe(false);
			expect(effectiveStatusFromFile(TEST_ID)).toBe("idle");
		} finally {
			// Best-effort cleanup if any of the above failed.
			try {
				clearTurnRunner(TEST_ID, process.pid);
			} catch {
				/* ignore */
			}
		}
	});
});
