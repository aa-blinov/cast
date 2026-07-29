import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runWebServerMain does a lot of real work (disk, network, a live HTTP
// server) — every dependency it touches is mocked here so the test can
// control exactly one thing: the ordering between the deferred MCP
// connect's promise resolving and the SIGTERM shutdown handler running.
// That's the one behavior that couldn't be forced reliably through real
// process timing (see bridge.ts's applyMcpResult / web/index.ts's
// shuttingDown guard) — mocking resolveMcpForCwd with a manually-controlled
// promise makes the race deterministic instead of a coin flip against
// however long a real MCP connect happens to take on a given machine.

const applyMcpResultSpy = vi.fn();
const closeMcpConnectionsSpy = vi.fn();

vi.mock("../src/core/mcp.ts", () => ({
	closeMcpConnections: closeMcpConnectionsSpy,
}));

let resolveMcpForCwdImpl: () => Promise<{ connections: string[] }> = () => Promise.resolve({ connections: [] });
vi.mock("../src/core/project.ts", () => ({
	resolveMcpForCwd: (...args: unknown[]) => resolveMcpForCwdImpl(...(args as [])),
}));

vi.mock("../src/core/settings.ts", () => ({
	loadSettings: vi.fn(() => ({ webPassword: "test-password", disabledMcpServers: [] })),
	updateSettings: vi.fn(),
}));

vi.mock("../src/core/startup.ts", () => ({
	runStartup: vi.fn(async () => ({
		projectDeps: {},
		cwd: "/tmp/fake-cwd",
		projectTrusted: true,
		persona: { label: "Test Persona" },
		session: { model: "test-model" },
	})),
}));

vi.mock("../src/web/bridge.ts", () => ({
	createWebBridge: vi.fn(() => ({
		createSession: vi.fn(),
		listSessions: vi.fn(() => []),
		closeSession: vi.fn(),
		applyMcpResult: applyMcpResultSpy,
	})),
}));

vi.mock("../src/web/daemon-state.ts", () => ({
	writeWebState: vi.fn(),
	clearWebState: vi.fn(),
}));

let capturedOnListening: (() => void) | undefined;
vi.mock("../src/web/server.ts", () => ({
	startWebServer: vi.fn((opts: { onListening: () => void }) => {
		capturedOnListening = opts.onListening;
		return { close: (cb: () => void) => cb() };
	}),
}));

describe("runWebServerMain — deferred MCP connect vs. shutdown race", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		capturedOnListening = undefined;
		// shutdown() calls process.exit(0) — without stubbing this out, running
		// it for real would kill the vitest worker process running this test.
		exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		exitSpy.mockRestore();
		process.removeAllListeners("SIGTERM");
	});

	it("applies the background MCP result when it resolves before shutdown", async () => {
		let resolveConnect!: (v: { connections: string[] }) => void;
		resolveMcpForCwdImpl = () =>
			new Promise((r) => {
				resolveConnect = r;
			});

		const { runWebServerMain } = await import("../src/web/index.ts");
		await runWebServerMain(["--port", "0"], { foreground: true });

		expect(capturedOnListening).toBeTruthy();
		capturedOnListening!();

		resolveConnect({ connections: ["conn-a"] });
		await Promise.resolve();
		await Promise.resolve();

		expect(applyMcpResultSpy).toHaveBeenCalledWith({ connections: ["conn-a"] });
		expect(closeMcpConnectionsSpy).not.toHaveBeenCalled();
	});

	it("closes the connections instead of applying them when shutdown fires before the connect resolves", async () => {
		let resolveConnect!: (v: { connections: string[] }) => void;
		resolveMcpForCwdImpl = () =>
			new Promise((r) => {
				resolveConnect = r;
			});

		const { runWebServerMain } = await import("../src/web/index.ts");
		await runWebServerMain(["--port", "0"], { foreground: true });

		expect(capturedOnListening).toBeTruthy();
		capturedOnListening!();

		// SIGTERM arrives — sets shuttingDown = true — strictly before the
		// deferred MCP connect below ever resolves.
		process.emit("SIGTERM");

		resolveConnect({ connections: ["conn-b"] });
		await Promise.resolve();
		await Promise.resolve();

		expect(closeMcpConnectionsSpy).toHaveBeenCalledWith(["conn-b"]);
		expect(applyMcpResultSpy).not.toHaveBeenCalled();
	});
});
