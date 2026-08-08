import { describe, expect, it, vi } from "vitest";

import { handleSseEvent } from "../src/server/public/sse-events.js";

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

		expect(state.resetStreamingNow).toHaveBeenCalledOnce();
		expect(state.setRunning).toHaveBeenCalledWith(false);
		expect(state.setPlanTransition).toHaveBeenCalledWith({ kind: "done", sessionId: "session-1" });
		expect(state.pendingPlanSignalRef.current).toBeNull();
	});

	it("renders a notice as a warning row instead of failing the turn", () => {
		const state = createContext();
		handleSseEvent({ type: "notice", message: "Provider changed — switched to hy3" }, state);

		expect(state.setSession).toHaveBeenCalled();
		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => unknown;
		expect(updater({ messages: [] })).toEqual({
			messages: [{ role: "warning", content: "Provider changed — switched to hy3" }],
		});
	});

	it("surfaces a retry as a warning row", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 3, reason: "429 Token Plan usage limit reached" }, state);

		const updater = state.setSession.mock.calls[0]![0] as (prev: unknown) => unknown;
		expect(updater({ messages: [] })).toEqual({
			messages: [{ role: "warning", content: "[Retrying (attempt 3): 429 Token Plan usage limit reached]" }],
		});
	});

	it("updates the same retry row on subsequent attempts instead of spamming history", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 1, reason: "429" }, state);
		handleSseEvent({ type: "retry", attempt: 2, reason: "429" }, state);

		const updater = state.setSession.mock.calls[1]![0] as (prev: unknown) => unknown;
		expect(updater({ messages: [{ role: "warning", content: "[Retrying (attempt 1): 429]" }] })).toEqual({
			messages: [{ role: "warning", content: "[Retrying (attempt 2): 429]" }],
		});
	});

	it("drops the retry row once real content starts streaming", () => {
		const state = createContext();
		handleSseEvent({ type: "retry", attempt: 1, reason: "429" }, state);
		handleSseEvent({ type: "token", text: "Hello" }, state);

		const updater = state.setSession.mock.calls[1]![0] as (prev: unknown) => unknown;
		expect(updater({ messages: [{ role: "warning", content: "[Retrying (attempt 1): 429]" }] })).toEqual({
			messages: [],
		});
	});
});
