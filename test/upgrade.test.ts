import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion, isAlreadyUpToDate, isNewerVersion, restartDaemon } from "../src/core/upgrade.ts";
import { clearServerState, isProcessAlive, readServerState } from "../src/server/daemon-state.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(() => ({ status: 0 })) };
});
vi.mock("../src/server/daemon-state.ts", () => ({
	readServerState: vi.fn(),
	isProcessAlive: vi.fn(),
	clearServerState: vi.fn(),
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
		vi.mocked(isProcessAlive).mockReset();
	});

	it("does nothing when no daemon is running", () => {
		vi.mocked(readServerState).mockReturnValue(undefined);
		restartDaemon();
		expect(spawnSync).not.toHaveBeenCalled();
		expect(clearServerState).not.toHaveBeenCalled();
	});

	it("restarts a live daemon on the new build", () => {
		vi.mocked(readServerState).mockReturnValue({
			pid: 424242,
			host: "127.0.0.1",
			port: 1337,
			startedAt: "t",
			foreground: false,
		});
		vi.mocked(isProcessAlive).mockReturnValue(true);
		vi.spyOn(process, "kill").mockImplementation(() => {});
		restartDaemon();
		expect(clearServerState).toHaveBeenCalled();
		expect(spawnSync).toHaveBeenCalledWith("bash", ["-c", "cast server start --port 0"], { stdio: "inherit" });
	});
});
