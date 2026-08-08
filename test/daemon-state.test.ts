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
		// effect before writeServerState is ever called — mirror that precondition
		// here rather than making writeServerState defensively mkdir a directory
		// its one real caller already guarantees exists.
		mkdirSync(join(fakeHome, ".cast"), { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("readServerState returns undefined when no state file exists yet", async () => {
		const { readServerState } = await import("../src/server/daemon-state.ts");
		expect(readServerState()).toBeUndefined();
	});

	it("round-trips a written state through readServerState", async () => {
		const { writeServerState, readServerState } = await import("../src/server/daemon-state.ts");
		const state = {
			pid: process.pid,
			port: 1337,
			host: "127.0.0.1",
			startedAt: new Date().toISOString(),
			foreground: false,
		};
		writeServerState(state);
		expect(readServerState()).toEqual(state);
	});

	it("self-heals a corrupt state file by treating it as absent instead of throwing", async () => {
		const { readServerState } = await import("../src/server/daemon-state.ts");
		writeFileSync(join(fakeHome, ".cast", "server.json"), "{not valid json");
		expect(readServerState()).toBeUndefined();
	});

	it("clearServerState is a no-op when the file is already gone", async () => {
		const { clearServerState } = await import("../src/server/daemon-state.ts");
		expect(() => clearServerState()).not.toThrow();
		expect(() => clearServerState()).not.toThrow();
	});

	it("readLiveServerState returns the state for a real, currently-alive process", async () => {
		const { writeServerState, readLiveServerState } = await import("../src/server/daemon-state.ts");
		writeServerState({ pid: process.pid, port: 1337, host: "127.0.0.1", startedAt: "now", foreground: false });
		expect(readLiveServerState()?.pid).toBe(process.pid);
	});

	it("readLiveServerState treats a dead recorded pid as stale and cleans it up", async () => {
		const { writeServerState, readLiveServerState, readServerState } = await import("../src/server/daemon-state.ts");
		// A pid essentially guaranteed not to correspond to a real process.
		const deadPid = 2_147_483_646;
		writeServerState({ pid: deadPid, port: 1337, host: "127.0.0.1", startedAt: "now", foreground: false });
		expect(readLiveServerState()).toBeUndefined();
		// The stale file must actually be removed, not just ignored this once.
		expect(readServerState()).toBeUndefined();
	});

	it("isProcessAlive is true for this process and false for a pid that doesn't exist", async () => {
		const { isProcessAlive } = await import("../src/server/daemon-state.ts");
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(2_147_483_646)).toBe(false);
	});

	it("acquireStartLock succeeds alone and serializes concurrent holders", async () => {
		const { acquireStartLock, releaseStartLock } = await import("../src/server/daemon-state.ts");
		expect(acquireStartLock()).toBe(true);
		// A second acquire from the same process writes the same pid — the
		// lock is single-holder by pid, so a re-entrant call is rejected
		// (the file is already there and its holder is alive).
		expect(acquireStartLock()).toBe(false);
		releaseStartLock();
		// Released — acquire works again.
		expect(acquireStartLock()).toBe(true);
		releaseStartLock();
	});

	it("releaseStartLock only removes a lock owned by this process", async () => {
		const { acquireStartLock, releaseStartLock } = await import("../src/server/daemon-state.ts");
		acquireStartLock();
		// Overwrite the lock with a different holder's pid (another live
		// process — the vitest parent) — release must not delete it, and
		// acquire must not steal it from a live holder.
		writeFileSync(join(fakeHome, ".cast", "server-start.lock"), String(process.ppid));
		releaseStartLock();
		expect(acquireStartLock()).toBe(false);
		// Cleanup: a dead holder is fair game, so acquire steals the lock.
		writeFileSync(join(fakeHome, ".cast", "server-start.lock"), "2_147_483_646".replaceAll("_", ""));
		expect(acquireStartLock()).toBe(true);
		releaseStartLock();
	});
});
