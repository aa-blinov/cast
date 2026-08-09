import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("cast web", () => {
	let originalArgv: string[];
	let log: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalArgv = process.argv;
		process.argv = [process.execPath, "src/index.ts", "web", "status"];
		log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.resetModules();
		vi.doMock("../src/server/daemon-state.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/server/daemon-state.ts")>();
			return { ...actual, readServerState: () => undefined };
		});
	});

	afterEach(() => {
		process.argv = originalArgv;
		log.mockRestore();
		vi.doUnmock("../src/server/daemon-state.ts");
	});

	it.each(["web", "server"])("routes `%s status` to the server daemon", async (command) => {
		process.argv[2] = command;
		await import("../src/index.ts");
		await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[cast server] not running"));
	});
});
