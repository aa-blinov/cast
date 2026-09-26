import { describe, expect, it, vi } from "vitest";

import { handleSseEvent } from "../src/server/public/sse-events.js";
import { getSubagentProgress, subscribeSubagentProgress } from "../src/server/public/tool-card-state.js";

function createContext() {
	return {
		streamSessionId: "session-1",
		setSession: vi.fn(),
		setSessions: vi.fn(),
		setRunning: vi.fn(),
		setPendingSteers: vi.fn(),
		setPendingQueue: vi.fn(),
		setPlanTransition: vi.fn(),
		pendingPlanSignalRef: { current: null },
		selfClosingRef: { current: null },
		activeId: "session-1",
		wasRunningRef: { current: false },
		updateStreaming: vi.fn(),
		resetStreamingNow: vi.fn(),
		takeStreamingNow: vi.fn(() => []),
		diffOpenRef: { current: false },
		queueDiffRefresh: vi.fn(),
		setFsRefreshNonce: vi.fn(),
		addNotice: vi.fn(),
		showToast: vi.fn(),
		api: vi.fn(),
		isCurrent: () => true,
		mergeHistoryPage: (previous: unknown[]) => previous,
	};
}

describe("web SSE events", () => {
	it("forwards streaming events without changing their order", () => {
		const state = createContext();
		handleSseEvent({ type: "thinking", text: "first" }, state);
		handleSseEvent({ type: "token", text: "second" }, state);
		handleSseEvent({ type: "tool_start", id: "tool-1", name: "bash", args: "{}", status: "running" }, state);

		expect(state.updateStreaming.mock.calls).toEqual([
			[{ type: "thinking", text: "first" }],
			[{ type: "content", text: "second" }],
			[{ type: "tool_start", call: { id: "tool-1", name: "bash", args: "{}", status: "running" } }],
		]);
	});

	it("completes a turn and promotes a pending plan transition", () => {
		const state = createContext();
		state.pendingPlanSignalRef.current = { kind: "done", sessionId: "session-1" };
		handleSseEvent({ type: "end" }, state);

		expect(state.takeStreamingNow).toHaveBeenCalledOnce();
		expect(state.setRunning).toHaveBeenCalledWith(false);
		expect(state.setPlanTransition).toHaveBeenCalledWith({ kind: "done", sessionId: "session-1" });
		expect(state.pendingPlanSignalRef.current).toBeNull();
	});

	it("keeps what streamed when a turn is stopped, with the abort notice after it", () => {
		const state = createContext();
		state.takeStreamingNow = vi.fn(() => [
			{ kind: "content", text: "half an answer" },
			{ kind: "tool", call: { id: "t1", name: "bash", status: "running" } },
		]);
		handleSseEvent({ type: "end", reason: "aborted" }, state);

		let session = { messages: [{ role: "user", content: "go" }] };
		for (const [updater] of state.setSession.mock.calls)
			session = (updater as (p: unknown) => typeof session)(session);
		expect(session.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "warning"]);
		const settled = session.messages[1] as { blocks: Array<{ kind: string; call?: { status: string } }> };
		expect(settled.blocks[0]).toEqual({ kind: "content", text: "half an answer" });
		// A call that was still running will never finish; it must not spin forever.
		expect(settled.blocks[1]?.call?.status).toBe("error");
		expect(session.messages[2]).toMatchObject({ content: "Run aborted", local: true });
	});

	it("keeps the streamed reply when a turn fails, then shows the error", () => {
		const state = createContext();
		state.takeStreamingNow = vi.fn(() => [{ kind: "content", text: "before the failure" }]);
		handleSseEvent({ type: "error", message: "Provider overloaded" }, state);

		let session = { messages: [] as Array<Record<string, unknown>> };
		for (const [updater] of state.setSession.mock.calls)
			session = (updater as (p: unknown) => typeof session)(session);
		expect(session.messages.map((m) => m.role)).toEqual(["assistant", "error"]);
		expect(session.messages[1]).toMatchObject({ content: "Provider overloaded", local: true });
	});

	it("does not refetch history just because the client has its own notice rows", () => {
		const state = createContext();
		handleSseEvent({ type: "session_end", usage: {}, messageCount: 2 }, state);
		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => unknown;
		updater({
			messages: [
				{ role: "user", content: "a" },
				{ role: "error", content: "boom", local: true },
				{ role: "assistant", content: "b" },
			],
		});
		expect(state.api).not.toHaveBeenCalled();
	});

	it("shows a tool call once when its completion streamed nothing before it", () => {
		const state = createContext();
		// assistant_message rebuilt from the event already carries the call...
		handleSseEvent(
			{ type: "assistant_message", content: "", toolCalls: [{ id: "c1", name: "skill_install", arguments: "{}" }] },
			state,
		);
		// ...and the live tool_start for the same call follows.
		handleSseEvent({ type: "tool_start", id: "c1", name: "skill_install", args: "{}", status: "running" }, state);

		let session = { messages: [{ role: "user", content: "go" }] as unknown[] };
		for (const [updater] of state.setSession.mock.calls)
			session = (updater as (p: unknown) => typeof session)(session);
		expect(session.messages).toEqual([{ role: "user", content: "go" }]);
		expect(state.updateStreaming).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_start" }));
	});

	it("refreshes the slash-command palette when the agent installs a skill", () => {
		const state = { ...createContext(), refreshCommands: vi.fn() };
		handleSseEvent({ type: "skills_changed" }, state);
		expect(state.refreshCommands).toHaveBeenCalledOnce();
	});

	it("renders a notice as a warning row instead of failing the turn", () => {
		const state = createContext();
		handleSseEvent({ type: "notice", message: "Provider changed — switched to hy3" }, state);

		expect(state.setSession).toHaveBeenCalled();
		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => unknown;
		expect(updater({ messages: [] })).toEqual({
			messages: [{ role: "warning", content: "Provider changed — switched to hy3", local: true }],
		});
	});

	it("invalidates the Files tree even when the diff panel is closed", () => {
		const state = createContext();
		handleSseEvent(
			{
				type: "tool_end",
				id: "tool-1",
				name: "write",
				status: "completed",
				result: { content: "created file", isError: false },
			},
			state,
		);

		expect(state.setFsRefreshNonce).toHaveBeenCalledOnce();
		expect(state.queueDiffRefresh).not.toHaveBeenCalled();
	});

	const applyAll = (state: ReturnType<typeof createContext>, session: { messages: unknown[] }) => {
		let next = session;
		for (const [updater] of state.setSession.mock.calls) next = (updater as (p: unknown) => typeof next)(next);
		return next;
	};

	it("surfaces a retry as a warning row that logs the attempt", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 3, reason: "429 Token Plan usage limit reached" }, state);

		expect(applyAll(state, { messages: [] }).messages).toEqual([
			{
				role: "warning",
				notice: "retry",
				local: true,
				attempts: [{ attempt: 3, reason: "429 Token Plan usage limit reached" }],
				content: "Provider retries:\n- attempt 3: 429 Token Plan usage limit reached",
			},
		]);
	});

	it("collects consecutive attempts into one row instead of spamming history", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 1, reason: "529" }, state);
		handleSseEvent({ type: "retry", attempt: 2, reason: "529" }, state);

		const rows = applyAll(state, { messages: [{ role: "user", content: "go" }] }).messages;
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ content: "Provider retries:\n- attempt 1: 529\n- attempt 2: 529" });
	});

	it("keeps the retry log once the reply starts streaming", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 1, reason: "529" }, state);
		handleSseEvent({ type: "token", text: "Hello" }, state);

		expect(applyAll(state, { messages: [] }).messages).toHaveLength(1);
		expect(state.updateStreaming).toHaveBeenCalledWith({ type: "content", text: "Hello" });
	});

	it("starts a new retry row for a later completion instead of rewriting an earlier turn's", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 1, reason: "529" }, state);
		const earlier = {
			role: "warning",
			notice: "retry",
			local: true,
			attempts: [{ attempt: 1, reason: "old" }],
			content: "old",
		};
		const rows = applyAll(state, { messages: [earlier, { role: "assistant", content: "done" }] }).messages;
		expect(rows[0]).toBe(earlier);
		expect(rows).toHaveLength(3);
	});

	it("acknowledges an optimistic user message by client id without appending a duplicate", () => {
		const state = createContext();
		handleSseEvent(
			{
				type: "user_message",
				message: { role: "user", content: "hello", clientMessageId: "msg-1" },
			},
			state,
		);

		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => unknown;
		expect(
			updater({ messages: [{ role: "user", content: "hello", clientMessageId: "msg-1", pending: true }] }),
		).toEqual({ messages: [{ role: "user", content: "hello", clientMessageId: "msg-1", pending: false }] });
	});

	it("shows a voice note sent from another tab as a playable data: URL", () => {
		const state = createContext();
		handleSseEvent(
			{
				type: "user_message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
					],
				},
			},
			state,
		);

		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => { messages: unknown[] };
		expect(updater({ messages: [] }).messages).toEqual([
			{ role: "user", content: "", audios: ["data:audio/wav;base64,UklGRg=="] },
		]);
	});

	it("keeps a task card's live subagent progress where a settled card can read it", () => {
		const progress = {
			type: "subagent_progress",
			toolCallId: "call-7",
			taskId: "child-1",
			subagent: "explore",
			description: "Map auth",
			background: true,
			status: "running",
			tool: { name: "read", summary: "src/auth.ts" },
			toolCount: 3,
		};
		const heard: string[] = [];
		const stop = subscribeSubagentProgress((id) => heard.push(id));
		handleSseEvent(progress, createContext());
		stop();
		expect(getSubagentProgress("call-7")).toMatchObject({ taskId: "child-1", toolCount: 3 });
		expect(heard).toEqual(["call-7"]);
	});

	it("refreshes the persona list when the agent saves one, and shows the switch it asked for", () => {
		const state = {
			...createContext(),
			refreshPersonas: vi.fn(),
			refreshCommands: vi.fn(),
			queuePersonaSession: vi.fn(),
		};
		handleSseEvent({ type: "personas_changed", persona: "haiku-poet" }, state);
		expect(state.refreshPersonas).toHaveBeenCalledTimes(1);
		expect(state.setSession).not.toHaveBeenCalled();

		handleSseEvent({ type: "personas_changed", persona: "haiku-poet", activate: "here" }, state);
		const here = state.setSession.mock.calls[0]![0] as (prev: unknown) => { persona?: string };
		expect(here({ id: "session-1", persona: "senior" }).persona).toBe("haiku-poet");

		handleSseEvent({ type: "personas_changed", persona: "haiku-poet", activate: "new" }, state);
		const fresh = state.setSession.mock.calls[1]![0] as (prev: unknown) => { persona?: string };
		expect(fresh({ id: "session-1", persona: "senior", cwd: "/work" }).persona).toBe("senior");
		expect(state.queuePersonaSession).toHaveBeenCalledWith("haiku-poet", "/work");
	});
});
