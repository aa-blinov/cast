import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { createSession } from "../src/core/session.ts";
import type { StartupResult } from "../src/core/startup.ts";

// submit() fires runAgentLoop in the background (fire-and-forget) — stub it
// so bridge tests don't need a live provider, but keep everything else
// (MessageQueue, event types) from the real module.
const runAgentLoop = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/core/loop.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/loop.ts")>();
	return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) };
});

const { createWebBridge, SANDBOX_CWD, toDisplayMessages } = await import("../src/web/bridge.ts");

const testConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 120,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
};

const emptyMcp: McpSetupResult = {
	toolIndex: new Map(),
	toolDefinitions: [],
	connections: [],
	diagnostics: [],
	allServerNames: [],
};

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "coding",
		label: "Coding",
		description: "Reads files, runs commands, edits code",
		systemPrompt: "You are the coding persona.",
		source: "builtin",
		filePath: "/builtin/coding.md",
		subagents: false,
		...overrides,
	} as Persona;
}

describe("web bridge", () => {
	let fakeHome: string;
	let realHome: string | undefined;
	let cwd: string;

	beforeEach(() => {
		runAgentLoop.mockClear();
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-web-bridge-test-"));
		process.env.HOME = fakeHome;
		cwd = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	function makeResult(overrides: Partial<StartupResult> = {}): StartupResult {
		const coding = makePersona();
		const senior = makePersona({ name: "senior", label: "Senior", systemPrompt: "You are the senior persona." });
		return {
			config: testConfig,
			cwd,
			systemPrompt: "unused — bridge rebuilds its own per-session prompt",
			session: createSession("gpt-4o", cwd),
			runner: createAgentRunner(),
			permissionMode: "default",
			mcpResult: emptyMcp,
			skills: [],
			persona: coding,
			personaOptions: {} as StartupResult["personaOptions"],
			personas: [coding, senior],
			subagentPrompts: [],
			confirmBash: async () => true,
			projectDeps: {} as StartupResult["projectDeps"],
			projectTrusted: true,
			contextFilesSuffix: "",
			rulesSuffix: "",
			rulesLazySuffix: "",
			directoryRules: [],
			activeAutoRules: [],
			skillsPromptSuffix: "",
			sshHosts: [],
			resumed: false,
			...overrides,
		};
	}

	describe("deleteSessionPermanently", () => {
		it("returns false for a session that never existed, live or on disk", () => {
			const bridge = createWebBridge(makeResult());
			expect(bridge.deleteSessionPermanently("no-such-session")).toBe(false);
		});

		it("removes a live session from the registry, unlike closeSession which just unloads it", async () => {
			const { appendMessage, loadSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			appendMessage(ws.session, { role: "user", content: "hi" });
			saveSession(ws.session);
			expect(loadSession(ws.id)).toBeDefined();

			expect(bridge.deleteSessionPermanently(ws.id)).toBe(true);

			expect(bridge.getSession(ws.id)).toBeUndefined();
			expect(loadSession(ws.id)).toBeNull();
		});

		it("removes a session that's only on disk (not currently live)", async () => {
			const { createSession, loadSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createWebBridge(makeResult());
			const orphan = createSession("gpt-4o", cwd);
			saveSession(orphan);
			expect(loadSession(orphan.id)).toBeDefined();

			expect(bridge.deleteSessionPermanently(orphan.id)).toBe(true);

			expect(loadSession(orphan.id)).toBeNull();
		});

		it("aborts a running session before deleting it", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			ws.status = "running";
			const abortSpy = vi.spyOn(ws.runner, "abort");
			bridge.deleteSessionPermanently(ws.id);
			expect(abortSpy).toHaveBeenCalledTimes(1);
		});

		it("also removes the session's attached-documents directory (~/.cast/inputs/<id>)", async () => {
			const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
			const { sessionInputsDir } = await import("../src/web/inputs.ts");
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			const dir = sessionInputsDir(ws.id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "report.pdf"), "fake pdf bytes");
			expect(existsSync(dir)).toBe(true);

			bridge.deleteSessionPermanently(ws.id);

			expect(existsSync(dir)).toBe(false);
		});

		it("doesn't error when a session with no attachments (the common case) is deleted", async () => {
			const { existsSync } = await import("node:fs");
			const { sessionInputsDir } = await import("../src/web/inputs.ts");
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			expect(existsSync(sessionInputsDir(ws.id))).toBe(false);

			expect(() => bridge.deleteSessionPermanently(ws.id)).not.toThrow();
		});
	});

	it("builds a persona-specific system prompt at session creation", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("sandbox sentinel derives a scratch dir named after the session id, created lazily on first message", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession(undefined, undefined, SANDBOX_CWD);
		const expectedDir = join(homedir(), ".cast", "sandbox", `cast-${ws.id}`);
		try {
			expect(ws.session.cwd).toBe(expectedDir);
			expect(ws.systemPrompt).toContain(`Current working directory: ${ws.session.cwd}`);
			// Not created yet — picking a persona/sandbox shouldn't leave a directory
			// behind for a session the user never actually used.
			expect(existsSync(ws.session.cwd)).toBe(false);

			bridge.submit(ws.id, "hi");
			expect(statSync(ws.session.cwd).isDirectory()).toBe(true);
		} finally {
			rmSync(ws.session.cwd, { recursive: true, force: true });
		}
	});

	it("a real cwd override is used as-is, not mistaken for the sandbox sentinel", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession(undefined, undefined, fakeHome);
		expect(ws.session.cwd).toBe(fakeHome);
	});

	it("/persona with no arg reports the current persona without changing anything", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona");
		expect(res).toEqual({ ok: true, result: { persona: "coding" } });
	});

	it("/persona <name> switches persona and rebuilds the system prompt", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona senior");
		expect(res.ok).toBe(true);
		expect(ws.session.persona).toBe("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("/persona <unknown> fails without mutating session state", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const before = ws.systemPrompt;
		const res = await bridge.executeCommand(ws.id, "/persona ghost");
		expect(res.ok).toBe(false);
		expect(ws.session.persona).toBe("coding");
		expect(ws.systemPrompt).toBe(before);
	});

	it("/quick-session-persona with no arg reports the current default ('coding' when never set)", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona");
		expect(res).toEqual({ ok: true, result: { quickSessionPersona: "coding" } });
	});

	it("/quick-session-persona <name> persists it and getConfig reflects the change", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona senior");
		expect(res).toEqual({ ok: true, result: { quickSessionPersona: "senior" } });
		expect(bridge.getConfig().quickSessionPersona).toBe("senior");
	});

	it("/quick-session-persona <unknown> fails without changing the current default", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona ghost");
		expect(res.ok).toBe(false);
		expect(bridge.getConfig().quickSessionPersona).toBe("coding");
	});

	it("/model <name> updates the session model", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/model gpt-5");
		expect(res).toEqual({ ok: true, result: { model: "gpt-5" } });
		expect(ws.session.model).toBe("gpt-5");
	});

	it("/model <name> becomes the default for sessions created afterward", async () => {
		const bridge = createWebBridge(makeResult());
		const first = bridge.createSession();
		expect(first.session.model).toBe("gpt-4o");
		await bridge.executeCommand(first.session.id, "/model gpt-5");
		const second = bridge.createSession();
		expect(second.session.model).toBe("gpt-5");
	});

	it("/model <name> broadcasts a session_update so the sidebar reflects it immediately", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const events: Array<{ type: string }> = [];
		bridge.subscribeAll((e) => events.push(e));
		await bridge.executeCommand(ws.id, "/model gpt-5");
		const update = events.find((e) => e.type === "session_update") as
			| { type: "session_update"; session: { model: string } }
			| undefined;
		expect(update?.session.model).toBe("gpt-5");
	});

	it("shareSession generates a token and getSharedSession returns a read-only projection by that token", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.title = "My thread";
		ws.session.messages.push(
			{ role: "system", content: "You are the coding persona. Project root: /home/secret/project" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		);

		const shared = bridge.shareSession(ws.id);
		expect(shared?.token).toBeTruthy();

		const view = bridge.getSharedSession(shared.token);
		expect(view?.title).toBe("My thread");
		expect(view?.model).toBe(ws.session.model);
		expect(view?.messages.some((m) => m.content === "hi there")).toBe(true);
		// The persona's system prompt (paths, tool internals) is for the
		// session's own owner, not an anonymous visitor with the link.
		expect(view?.messages.some((m) => m.role === "system")).toBe(false);
	});

	it("shareSession is idempotent — calling it twice returns the same token", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const first = bridge.shareSession(ws.id);
		const second = bridge.shareSession(ws.id);
		expect(second?.token).toBe(first?.token);
	});

	it("unshareSession revokes the token — getSharedSession no longer resolves it", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const shared = bridge.shareSession(ws.id);
		expect(bridge.unshareSession(ws.id)).toBe(true);
		expect(bridge.getSharedSession(shared.token)).toBeNull();
	});

	it("getSharedSession returns null for an unknown token, and shareSession/unshareSession return null/false for an unknown session", () => {
		const bridge = createWebBridge(makeResult());
		expect(bridge.getSharedSession("nonexistent")).toBeNull();
		expect(bridge.shareSession("nonexistent")).toBeNull();
		expect(bridge.unshareSession("nonexistent")).toBe(false);
	});

	it("/model and /persona are rejected while the agent is running", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		expect((await bridge.executeCommand(ws.id, "/model gpt-5")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/persona senior")).ok).toBe(false);
	});

	it("/steer while idle just sends the message as a normal turn", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Sent" });
		expect(runAgentLoop).toHaveBeenCalledTimes(1);
	});

	it("/steer while running enqueues into the steering queue instead of starting a new turn", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Steered into the running turn" });
		expect(runAgentLoop).not.toHaveBeenCalled();
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
	});

	it("submit() while a turn is already running steers instead of racing a second runAgentLoop", () => {
		// Two browser tabs on the same session both hitting "send" hit this
		// same code path — without the guard, both would call runAgentLoop
		// concurrently against the same ws.session, scrambling/interleaving
		// the persisted message order (see the real repro this fix closes).
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "first message");
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		bridge.submit(ws.id, "second message, from another tab");
		expect(runAgentLoop).toHaveBeenCalledTimes(1); // still just the one run
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
	});

	it("submit with images builds a [text, image_url...] content array, always including the text part", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "is this a Bengal?", ["data:image/jpeg;base64,ONE", "data:image/jpeg;base64,TWO"]);

		const sent = ws.session.messages.at(-1);
		expect(sent?.role).toBe("user");
		expect(sent?.content).toEqual([
			{ type: "text", text: "is this a Bengal?" },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ONE" } },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,TWO" } },
		]);
	});

	it("submit with no images stays a plain string (unchanged behavior)", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "hello");

		expect(ws.session.messages.at(-1)?.content).toBe("hello");
	});

	it("submit with images while a turn is running steers with the same array content instead of dropping the images", () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		bridge.submit(ws.id, "first message");
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		bridge.submit(ws.id, "and this photo", ["data:image/png;base64,X"]);

		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
		const [queued] = ws.runner.steeringQueue.drain();
		expect(queued?.content).toEqual([
			{ type: "text", text: "and this photo" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,X" } },
		]);
	});

	it("session_end's messageCount stays a raw per-completion count, not the turn count shown elsewhere", async () => {
		// The web client (app.js) appends one local message per raw
		// "assistant_message" SSE event — including tool-call-only
		// intermediates — and compares that length against this field to
		// decide whether a reconnect-recovery refetch is needed. If this were
		// turn-based (like the sidebar/settings "N msg" counters), it would
		// permanently mismatch on every tool-using turn and force a needless
		// refetch every single time.
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => [
			...messages,
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
			{ role: "assistant", content: "final reply" },
		]);

		const events: Array<{ type: string; messageCount?: number }> = [];
		bridge.subscribe(ws.id, (e) => events.push(e as { type: string; messageCount?: number }));

		bridge.submit(ws.id, "read a file");
		await new Promise((r) => setTimeout(r, 0));

		const sessionEnd = events.find((e) => e.type === "session_end");
		// 1 user + 2 assistant completions = 3 raw rows, not the 2 "turns"
		// (1 user + 1 final reply) countTurnMessages would report.
		expect(sessionEnd?.messageCount).toBe(3);
	});

	it("submit() broadcasts turn_meta with the model that answered, so the client can show it under the reply", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession(undefined, "gpt-5");

		runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => [
			...messages,
			{ role: "assistant", content: "final reply" },
		]);

		const events: Array<{ type: string; model?: string; provider?: string; totalMs?: number }> = [];
		bridge.subscribe(ws.id, (e) => events.push(e as (typeof events)[number]));

		bridge.submit(ws.id, "hi");
		await new Promise((r) => setTimeout(r, 0));

		const turnMeta = events.find((e) => e.type === "turn_meta");
		expect(turnMeta?.model).toBe("gpt-5");
		expect(turnMeta?.provider).toBe("default");
		expect(typeof turnMeta?.totalMs).toBe("number");
	});

	it("/queue while running enqueues a follow-up; /queue-reset clears it", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		await bridge.executeCommand(ws.id, "/queue after this turn");
		expect(ws.runner.followUpQueue.hasItems()).toBe(true);
		await bridge.executeCommand(ws.id, "/queue-reset");
		expect(ws.runner.followUpQueue.hasItems()).toBe(false);
	});

	it("/steer and /queue require a message", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		expect((await bridge.executeCommand(ws.id, "/steer")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/queue")).ok).toBe(false);
	});

	it("suggestCommand returns subcommands for bare commands", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();

		const mcpSuggestions = bridge.suggestCommand(ws.id, "/mcp");
		expect(mcpSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const skillsSuggestions = bridge.suggestCommand(ws.id, "/skills");
		expect(skillsSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const pluginSuggestions = bridge.suggestCommand(ws.id, "/plugin");
		expect(pluginSuggestions.map((s) => s.value)).toEqual([
			"list",
			"install",
			"uninstall",
			"enable",
			"disable",
			"marketplace",
			"help",
		]);

		const permissionsSuggestions = bridge.suggestCommand(ws.id, "/permissions");
		expect(permissionsSuggestions.map((s) => s.value)).toEqual(["default", "bypass"]);

		const sshSuggestions = bridge.suggestCommand(ws.id, "/ssh");
		expect(sshSuggestions.map((s) => s.value)).toEqual(["list", "add", "remove"]);
	});

	it("suggestCommand returns empty for unknown commands", async () => {
		const bridge = createWebBridge(makeResult());
		const ws = bridge.createSession();
		expect(bridge.suggestCommand(ws.id, "/unknown")).toEqual([]);
		expect(bridge.suggestCommand(ws.id, "/mcp enable unknown-server")).toEqual([]);
	});

	describe("SSE broadcast synchronicity", () => {
		it("delivers events to two listeners in the same synchronous tick", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			// Track which microtask tick each listener sees per event.
			// A microtask-based counter increments every time the event loop
			// yields. If broadcast were async, the two listeners would see
			// different tick values for at least one event.
			const counter = { value: 0 };
			let ticking = true;
			Promise.resolve().then(function tick() {
				counter.value++;
				if (ticking) Promise.resolve().then(tick);
			});

			const ticksAtListener1: number[] = [];
			const ticksAtListener2: number[] = [];
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			bridge.subscribe(ws.id, (e) => {
				ticksAtListener1.push(counter.value);
				received1.push(e);
			});
			bridge.subscribe(ws.id, (e) => {
				ticksAtListener2.push(counter.value);
				received2.push(e);
			});

			// submit() fires runAgentLoop and broadcasts a status event —
			// grab the onEvent callback it passes in.
			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};
			const onEvent = loopConfig.onEvent;

			// Clear the initial "status: running" event that submit() broadcast
			ticksAtListener1.length = 0;
			ticksAtListener2.length = 0;
			received1.length = 0;
			received2.length = 0;

			// Fire several events simulating a real LLM stream
			const events = [
				{ type: "token", text: "Hello" },
				{ type: "thinking", text: "reasoning..." },
				{ type: "token", text: " world" },
				{ type: "assistant_message", content: "Hello world", thinking: "reasoning..." },
				{ type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
				{ type: "end", reason: "stop" },
			];

			for (const event of events) {
				onEvent(event);
			}

			ticking = false;

			// Both listeners received every event
			expect(received1).toHaveLength(events.length);
			expect(received2).toHaveLength(events.length);

			// Events arrived in the same order
			for (let i = 0; i < events.length; i++) {
				expect(received1[i]).toBe(events[i]);
				expect(received2[i]).toBe(events[i]);
			}

			// The tick counter was identical for both listeners on every event
			// — proving no microtask ran between them (i.e. broadcast is sync).
			expect(ticksAtListener1).toEqual(ticksAtListener2);
		});

		it("a disconnected listener does not block delivery to remaining listeners", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			const goodEvents: unknown[] = [];

			// First listener throws (simulating a disconnected SSE client)
			bridge.subscribe(ws.id, () => {
				throw new Error("client disconnected");
			});
			// Second listener is healthy
			bridge.subscribe(ws.id, (e) => goodEvents.push(e));

			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};

			// Clear the initial "status: running" from submit()
			goodEvents.length = 0;

			loopConfig.onEvent({ type: "token", text: "ok" });
			loopConfig.onEvent({ type: "end", reason: "stop" });

			// Healthy listener got both events despite the first one throwing
			expect(goodEvents).toHaveLength(2);
			expect(goodEvents[0]).toEqual({ type: "token", text: "ok" });
			expect(goodEvents[1]).toEqual({ type: "end", reason: "stop" });
		});

		it("searchSessions finds a live (hydrated) session by message content via the FTS index", async () => {
			const { saveSession } = await import("../src/core/session.ts");
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			ws.session.messages.push(
				{ role: "user", content: "find the needle here" },
				{ role: "assistant", content: "got it" },
			);
			saveSession(ws.session); // every real mutation path saves synchronously — mirror that here

			const results = bridge.searchSessions("find the needle");
			expect(results.map((s) => s.id)).toContain(ws.id);
			// Live overlay still applies — status comes from the in-memory
			// session, not a fresh "idle" cold-load default.
			expect(results.find((s) => s.id === ws.id)?.status).toBe(ws.status);
		});

		it("searchSessions finds a cold session loaded from disk too, and empty query behaves like listSessions", async () => {
			const { appendMessage, createSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createWebBridge(makeResult());
			const orphan = createSession("gpt-4o", cwd);
			appendMessage(orphan, { role: "user", content: "deep unique needle in an unhydrated session" });
			saveSession(orphan);

			expect(bridge.searchSessions("deep unique needle").map((s) => s.id)).toContain(orphan.id);
			expect(bridge.searchSessions("no-such-term-anywhere")).toEqual([]);
			expect(bridge.searchSessions("").map((s) => s.id)).toEqual(bridge.listSessions().map((s) => s.id));
		});

		it("subscribe receives current status immediately on connection", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			// Simulate a running session
			ws.status = "running";

			// The SSE endpoint in server.ts sends current status via a direct
			// res.write before subscribing — here we verify the bridge exposes
			// the status so that path can read it.
			const summary = bridge.listSessions();
			const ours = summary.find((s) => s.id === ws.id);
			expect(ours?.status).toBe("running");
		});
	});

	describe("background bash tasks", () => {
		it("submit() threads backgroundBash into the LoopConfig passed to runAgentLoop", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			bridge.submit(ws.id, "hello");
			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as { backgroundBash?: unknown };
			expect(loopConfig.backgroundBash).toBe(ws.backgroundBash);
		});

		it("closeSession() kills any still-running background tasks", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			const killAllSpy = vi.spyOn(ws.backgroundBash.registry, "killAll");
			bridge.closeSession(ws.id);
			expect(killAllSpy).toHaveBeenCalledTimes(1);
		});

		it("deleteSessionPermanently() kills any still-running background tasks", () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			const killAllSpy = vi.spyOn(ws.backgroundBash.registry, "killAll");
			bridge.deleteSessionPermanently(ws.id);
			expect(killAllSpy).toHaveBeenCalledTimes(1);
		});

		// The whole point of the feature: a background task finishing while the
		// session is fully idle (no turn to steer into) still gets the model's
		// attention — via the registry's onIdleWake, wired to submit() at session
		// construction (bridge.ts's makeBackgroundBash), starting a fresh turn.
		it("a background task finishing while idle wakes a fresh turn with a <system-reminder>", async () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();

			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			bridge.submit(ws.id, "hello");
			await new Promise((r) => setTimeout(r, 0));
			expect(ws.status).toBe("idle");

			runAgentLoop.mockClear();
			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			ws.backgroundBash.registry.start("echo bg-wake-marker", cwd, testConfig, 5, ws.backgroundBash);
			await new Promise((r) => setTimeout(r, 500));

			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const lastMessage = ws.session.messages.at(-1);
			expect(lastMessage?.role).toBe("user");
			expect(String(lastMessage?.content)).toContain("<system-reminder>");
			expect(String(lastMessage?.content)).toContain("bg-wake-marker");
		});

		it("a background task finishing while a turn is still running enqueues onto followUpQueue instead", async () => {
			const bridge = createWebBridge(makeResult());
			const ws = bridge.createSession();
			ws.runner.startRun(new AbortController());

			ws.backgroundBash.registry.start("echo bg-followup-marker", cwd, testConfig, 5, ws.backgroundBash);
			await new Promise((r) => setTimeout(r, 500));

			expect(runAgentLoop).not.toHaveBeenCalled();
			expect(ws.runner.followUpQueue.hasItems()).toBe(true);
			const [queued] = ws.runner.followUpQueue.drain();
			expect(String(queued?.content)).toContain("bg-followup-marker");
		});
	});
});

// ============================================================================
// toDisplayMessages — image_url user messages (a `read` on an image file)
// ============================================================================

describe("toDisplayMessages — inline images from a read on an image file", () => {
	it("extracts data: URLs from an image_url user message instead of dropping them to null", () => {
		const out = toDisplayMessages([
			{ role: "user", content: "look at this" },
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
			} as never,
		]);

		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ role: "user", content: null, images: ["data:image/png;base64,AAAA"] });
	});

	it("extracts multiple images from a single image_url message", () => {
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: "data:image/png;base64,ONE" } },
					{ type: "image_url", image_url: { url: "data:image/png;base64,TWO" } },
				],
			} as never,
		]);

		expect(out[0]?.images).toEqual(["data:image/png;base64,ONE", "data:image/png;base64,TWO"]);
	});

	it("points at the image-blob route instead of inlining when sessionId+seqs are given", () => {
		// The whole point of the route: a session load must not carry full
		// base64 payloads for every embedded photo (that's what made this
		// session slow to load — see server.ts's /image route).
		const out = toDisplayMessages(
			[
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ONE" } },
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64,TWO" } },
					],
				} as never,
			],
			undefined,
			undefined,
			"abc123",
			[42],
		);

		expect(out[0]?.images).toEqual([
			"/api/sessions/abc123/image?seq=42&idx=0",
			"/api/sessions/abc123/image?seq=42&idx=1",
		]);
	});

	it("falls back to inlining when seqs is given but this index has none (not yet persisted)", () => {
		const out = toDisplayMessages(
			[{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,X" } }] } as never],
			undefined,
			undefined,
			"abc123",
			[], // no seq recorded for index 0
		);

		expect(out[0]?.images).toEqual(["data:image/png;base64,X"]);
	});

	it("attributes the image to its originating ToolCard via castToolCallId, not a floating message", () => {
		const out = toDisplayMessages([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
			} as never,
			{ role: "tool", tool_call_id: "call_1", content: "1:abc:def→(image content)" } as never,
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,PHOTO" } }],
				castToolCallId: "call_1",
			} as never,
		]);

		// Exactly one display message (the assistant/tool-call one) — the
		// image_url message must not also become its own floating entry.
		expect(out).toHaveLength(1);
		expect(out[0]?.role).toBe("assistant");
		expect(out[0]?.toolCalls?.[0]).toMatchObject({ id: "call_1", images: ["data:image/jpeg;base64,PHOTO"] });
	});

	it("resolves the attributed image through the same URL-vs-inline rule as the fallback path", () => {
		const out = toDisplayMessages(
			[
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
				} as never,
				{ role: "tool", tool_call_id: "call_1", content: "ok" } as never,
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,PHOTO" } }],
					castToolCallId: "call_1",
				} as never,
			],
			undefined,
			undefined,
			"sess1",
			[10, 11, 12],
		);

		expect(out[0]?.toolCalls?.[0]?.images).toEqual(["/api/sessions/sess1/image?seq=12&idx=0"]);
	});

	it("leaves a normal string user message untouched (no images field)", () => {
		const out = toDisplayMessages([{ role: "user", content: "hello" }]);
		expect(out[0]).toEqual({ role: "user", content: "hello" });
		expect(out[0]?.images).toBeUndefined();
	});

	it("keeps the caption alongside the photo for a real user send (text part present)", () => {
		// A real attach-and-send (see bridge.ts's buildUserContent) always
		// includes a text part, even when empty — that's what distinguishes it
		// from the tool-only image_url relay, which never has one.
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "is this a Bengal?" },
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,CAT" } },
				],
			} as never,
		]);
		expect(out[0]).toEqual({ role: "user", content: "is this a Bengal?", images: ["data:image/jpeg;base64,CAT"] });
	});

	it("keeps a caption-less real send distinguishable (empty string, not null) from a tool relay", () => {
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,X" } },
				],
			} as never,
		]);
		// content: "" (a real, if caption-less, send) — not null (which the
		// client renders as "image (read)" instead of "you").
		expect(out[0]?.content).toBe("");
	});

	it("strips a <system-reminder> out of the visible caption when images and an attached document are sent together", () => {
		// A message with both an image and an attached document (see
		// inputs.ts) carries its reminder inside the same text part images
		// use — without extraction here, it used to leak as raw XML into the
		// visible bubble instead of surfacing as a separate notice the way
		// the plain-string branch already handles it.
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "check this out\n\n<system-reminder>\nAttached: /tmp/report.pdf\n</system-reminder>",
					},
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,X" } },
				],
			} as never,
		]);
		expect(out.find((m) => m.role === "user")?.content).toBe("check this out");
		expect(out.find((m) => m.role === "warning")?.content).toBe("[system] Attached: /tmp/report.pdf");
	});
});
