import { describe, expect, it, vi } from "vitest";

import { handleSseEvent } from "../src/web/public/sse-events.js";

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
});
