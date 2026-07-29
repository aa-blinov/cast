import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// daemon-state.ts computes its state-file path once, from homedir(), at
// module load time (a top-level const, not recomputed per call) — so each
// test needs its own fresh module instance via resetModules(), loaded AFTER
// HOME is repointed at that test's own temp dir. Without this, whichever
// test happens to import the module first freezes the path for every test
// in the file, and every later test silently operates on the FIRST test's
// (by then deleted) temp directory instead of its own.
describe("daemon-state", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-daemon-state-test-"));
		process.env.HOME = fakeHome;
		// The real caller (runWebServerMain) always touches settings.ts first
		// (loadSettings/updateSettings), which creates ~/.cast/ as a side
		// effect before writeWebState is ever called — mirror that precondition
		// here rather than making writeWebState defensively mkdir a directory
		// its one real caller already guarantees exists.
		mkdirSync(join(fakeHome, ".cast"), { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("readWebState returns undefined when no state file exists yet", async () => {
		const { readWebState } = await import("../src/web/daemon-state.ts");
		expect(readWebState()).toBeUndefined();
	});

	it("round-trips a written state through readWebState", async () => {
		const { writeWebState, readWebState } = await import("../src/web/daemon-state.ts");
		const state = {
			pid: process.pid,
			port: 1337,
			host: "127.0.0.1",
			startedAt: new Date().toISOString(),
			foreground: false,
		};
		writeWebState(state);
		expect(readWebState()).toEqual(state);
	});

	it("self-heals a corrupt state file by treating it as absent instead of throwing", async () => {
		const { readWebState } = await import("../src/web/daemon-state.ts");
		writeFileSync(join(fakeHome, ".cast", "web.json"), "{not valid json");
		expect(readWebState()).toBeUndefined();
	});

	it("clearWebState is a no-op when the file is already gone", async () => {
		const { clearWebState } = await import("../src/web/daemon-state.ts");
		expect(() => clearWebState()).not.toThrow();
		expect(() => clearWebState()).not.toThrow();
	});

	it("readLiveWebState returns the state for a real, currently-alive process", async () => {
		const { writeWebState, readLiveWebState } = await import("../src/web/daemon-state.ts");
		writeWebState({ pid: process.pid, port: 1337, host: "127.0.0.1", startedAt: "now", foreground: false });
		expect(readLiveWebState()?.pid).toBe(process.pid);
	});

	it("readLiveWebState treats a dead recorded pid as stale and cleans it up", async () => {
		const { writeWebState, readLiveWebState, readWebState } = await import("../src/web/daemon-state.ts");
		// A pid essentially guaranteed not to correspond to a real process.
		const deadPid = 2_147_483_646;
		writeWebState({ pid: deadPid, port: 1337, host: "127.0.0.1", startedAt: "now", foreground: false });
		expect(readLiveWebState()).toBeUndefined();
		// The stale file must actually be removed, not just ignored this once.
		expect(readWebState()).toBeUndefined();
	});

	it("isProcessAlive is true for this process and false for a pid that doesn't exist", async () => {
		const { isProcessAlive } = await import("../src/web/daemon-state.ts");
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(2_147_483_646)).toBe(false);
	});
});
