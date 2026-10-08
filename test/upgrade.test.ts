import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion, isAlreadyUpToDate, isNewerVersion, restartDaemon } from "../src/core/upgrade.ts";
import {
	acquireStartLock,
	clearServerState,
	isCurrentDaemonInstance,
	isProcessAlive,
	readLiveServerState,
	readServerState,
	releaseStartLock,
} from "../src/server/daemon-state.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0 })),
		spawn: vi.fn(() => ({ unref: vi.fn() })),
	};
});
const remembered = vi.hoisted(() => ({ bind: undefined as { host: string; port: number } | undefined }));
vi.mock("../src/server/daemon-bind.ts", () => ({ rememberedBind: () => remembered.bind }));
vi.mock("../src/server/daemon-state.ts", () => ({
	daemonBaseUrl: (state: { host: string; port: number }) => `http://${state.host}:${state.port}`,
	readServerState: vi.fn(),
	readLiveServerState: vi.fn(),
	isProcessAlive: vi.fn(),
	isCurrentDaemonInstance: vi.fn(),
	clearServerState: vi.fn(),
	acquireStartLock: vi.fn(() => true),
	releaseStartLock: vi.fn(),
	START_LOCK_WAIT_ATTEMPTS: 3,
}));

describe("isNewerVersion", () => {
	it("detects a newer patch version", () => {
		expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
	});

	it("detects a newer minor version", () => {
		expect(isNewerVersion("0.1.9", "0.2.0")).toBe(true);
	});

	it("detects a newer major version", () => {
		expect(isNewerVersion("1.9.9", "2.0.0")).toBe(true);
	});

	it("returns false for the same version", () => {
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
	});

	it("returns false for an older candidate", () => {
		expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
	});

	it("handles a leading 'v' on either side", () => {
		expect(isNewerVersion("v0.1.0", "v0.2.0")).toBe(true);
		expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
	});

	it("handles differing segment counts (missing patch treated as 0)", () => {
		expect(isNewerVersion("0.1", "0.1.1")).toBe(true);
		expect(isNewerVersion("0.1.0", "0.1")).toBe(false);
	});
});

describe("fetchLatestVersion", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("strips the 'v' prefix from the tag name", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 }),
		) as any;
		expect(await fetchLatestVersion()).toBe("1.2.3");
	});

	it("returns null on a non-ok response instead of throwing", async () => {
		globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null on a network error instead of throwing", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		}) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null when the response has no tag_name", async () => {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as any;
		expect(await fetchLatestVersion()).toBeNull();
	});
});

describe("isAlreadyUpToDate", () => {
	it("is true when current matches the target", () => {
		expect(isAlreadyUpToDate("0.2.0", "0.2.0", false)).toBe(true);
	});

	it("handles a leading 'v' on either side", () => {
		expect(isAlreadyUpToDate("0.2.0", "v0.2.0", false)).toBe(true);
		expect(isAlreadyUpToDate("v0.2.0", "0.2.0", false)).toBe(true);
	});

	it("is false when versions differ", () => {
		expect(isAlreadyUpToDate("0.1.0", "0.2.0", false)).toBe(false);
	});

	it("--force always reinstalls, even on a version match", () => {
		expect(isAlreadyUpToDate("0.2.0", "0.2.0", true)).toBe(false);
	});

	it("never skips when the target is unknown (fetchLatestVersion failed) — let the installer surface its own error", () => {
		expect(isAlreadyUpToDate("0.2.0", null, false)).toBe(false);
	});
});

describe("restartDaemon", () => {
	beforeEach(() => {
		vi.mocked(spawnSync).mockClear();
		vi.mocked(clearServerState).mockClear();
		vi.mocked(readServerState).mockReset();
		vi.mocked(readLiveServerState).mockReset();
		vi.mocked(isProcessAlive).mockReset();
		vi.mocked(isCurrentDaemonInstance).mockReset();
		vi.mocked(acquireStartLock).mockReset().mockReturnValue(true);
		vi.mocked(releaseStartLock).mockClear();
	});

	it("does nothing when no daemon is running", async () => {
		vi.mocked(readServerState).mockReturnValue(undefined);
		await restartDaemon();
		expect(spawnSync).not.toHaveBeenCalled();
		expect(clearServerState).not.toHaveBeenCalled();
	});

	it("restarts a verified daemon on the same host and port", async () => {
		vi.mocked(readServerState).mockReturnValueOnce({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(readServerState).mockReturnValue({
			pid: 424243,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "new",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		vi.mocked(readLiveServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.spyOn(process, "kill").mockImplementation(() => {});
		expect(await restartDaemon()).toBe(true);
		expect(clearServerState).toHaveBeenCalled();
		expect(spawnSync).toHaveBeenCalledWith(
			"cast",
			["server", "start", "--port", "1337", "--host", "127.0.0.1", "--no-remember"],
			{
				stdio: "inherit",
			},
		);
	});

	it("hands its own restart to a detached waiter instead of SIGTERMing itself", async () => {
		// The web UI's Upgrade button calls runUpgrade inside the daemon, so the
		// recorded pid is this process. SIGTERM here is suicide: the shutdown
		// handler exits within seconds and the spawnSync that starts the
		// replacement never runs, leaving a new install and no daemon.
		vi.mocked(readServerState).mockReturnValue({
			pid: process.pid,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {});

		expect(await restartDaemon()).toBe(true);

		expect(spawnSync).not.toHaveBeenCalled();
		const [command, args, options] = vi.mocked(spawn).mock.calls[0];
		expect(command).toBe("sh");
		expect(String(args?.[1])).toContain(`kill -0 ${process.pid}`);
		expect(String(args?.[1])).toContain("cast server start --port 1337 --host 127.0.0.1 --no-remember");
		expect(options).toMatchObject({ detached: true });
		// Still shuts down, so sessions drain — just after the waiter exists.
		expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
	});

	it("does not signal a PID that cannot be verified as the daemon", async () => {
		vi.mocked(readServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(false);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {});
		expect(await restartDaemon()).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("leaves a verified foreground daemon running for its owning terminal", async () => {
		vi.mocked(readServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: true,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {});
		expect(await restartDaemon()).toBe(true);
		expect(kill).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("brings the daemon back on the address the person chose, even if it had fallen back to a private one", async () => {
		remembered.bind = { host: "0.0.0.0", port: 1337 };
		try {
			vi.mocked(readServerState).mockReturnValueOnce({
				pid: 424242,
				host: "127.0.0.1",
				port: 44453,
				startedAt: "t",
				foreground: false,
			});
			vi.mocked(readServerState).mockReturnValue({
				pid: 424243,
				host: "0.0.0.0",
				port: 1337,
				startedAt: "new",
				foreground: false,
			});
			vi.mocked(isProcessAlive).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
			vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
			vi.mocked(readLiveServerState).mockReturnValue({
				pid: 424242,
				host: "127.0.0.1",
				port: 44453,
				startedAt: "t",
				foreground: false,
			});
			vi.spyOn(process, "kill").mockImplementation(() => {});
			expect(await restartDaemon()).toBe(true);
			// And an upgrade is not a choice: it must not remember the address it restarts on.
			expect(spawnSync).toHaveBeenCalledWith(
				"cast",
				["server", "start", "--port", "1337", "--host", "0.0.0.0", "--no-remember"],
				{ stdio: "inherit" },
			);
		} finally {
			remembered.bind = undefined;
		}
	});

	describe("a turn is running when the upgrade restarts the daemon", () => {
		const daemon = {
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
			token: "tok",
		};
		const sessions = (...statuses: string[]) =>
			new Response(JSON.stringify(statuses.map((status, i) => ({ id: `s${i}`, status }))), { status: 200 });

		beforeEach(() => {
			vi.mocked(readServerState).mockReturnValueOnce(daemon);
			vi.mocked(readServerState).mockReturnValue({ ...daemon, pid: 424243, startedAt: "new" });
			vi.mocked(readLiveServerState).mockReturnValue(daemon);
			vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("waits until it is over, and only then stops the daemon", async () => {
			vi.mocked(isProcessAlive).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
			const kill = vi.spyOn(process, "kill").mockImplementation(() => {});
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(sessions("idle", "running"))
				.mockResolvedValueOnce(sessions("idle", "running"))
				.mockResolvedValue(sessions("idle", "idle"));
			vi.stubGlobal("fetch", fetchMock);
			expect(await restartDaemon({ turnPollMs: 5, turnWaitMs: 5_000 })).toBe(true);
			expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
			expect(kill).toHaveBeenCalledWith(424242, "SIGTERM");
			expect(spawnSync).toHaveBeenCalled();
		});

		it("leaves the daemon on the old build when the turn does not finish in time", async () => {
			vi.mocked(isProcessAlive).mockReturnValue(true);
			const kill = vi.spyOn(process, "kill").mockImplementation(() => {});
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation(async () => sessions("running")),
			);
			expect(await restartDaemon({ turnPollMs: 5, turnWaitMs: 40 })).toBe(true);
			expect(kill).not.toHaveBeenCalledWith(424242, "SIGTERM");
			expect(spawnSync).not.toHaveBeenCalled();
		});

		it("restarts at once when nothing is running", async () => {
			vi.mocked(isProcessAlive).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
			const kill = vi.spyOn(process, "kill").mockImplementation(() => {});
			const fetchMock = vi.fn().mockImplementation(async () => sessions("idle"));
			vi.stubGlobal("fetch", fetchMock);
			expect(await restartDaemon({ turnPollMs: 5, turnWaitMs: 5_000 })).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(kill).toHaveBeenCalledWith(424242, "SIGTERM");
		});
	});

	it("holds the shared start lock across the restart, so a concurrent starter cannot win the port", async () => {
		vi.mocked(readServerState).mockReturnValueOnce({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(readServerState).mockReturnValue({
			pid: 424243,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "new",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		vi.mocked(readLiveServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.spyOn(process, "kill").mockImplementation(() => {});

		expect(await restartDaemon()).toBe(true);
		expect(acquireStartLock).toHaveBeenCalled();
		expect(releaseStartLock).toHaveBeenCalled();
	});

	it("leaves the old daemon alone when another process holds the start lock", async () => {
		vi.mocked(readServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		vi.mocked(acquireStartLock).mockReturnValue(false);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {});

		expect(await restartDaemon()).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
		expect(releaseStartLock).not.toHaveBeenCalled();
	});

	it("does not signal a pid that changed while waiting for the start lock", async () => {
		vi.mocked(readServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.mocked(isCurrentDaemonInstance).mockResolvedValue(true);
		// Another process restarted the daemon while we waited for the lock.
		vi.mocked(readLiveServerState).mockReturnValue({
			pid: 424299,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "other",
			foreground: false,
		});
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {});

		expect(await restartDaemon()).toBe(true);
		expect(kill).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
		expect(releaseStartLock).toHaveBeenCalled();
	});
});
