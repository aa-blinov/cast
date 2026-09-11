import { describe, expect, it, vi } from "vitest";

vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));

import { api } from "../src/server/public/api.js";
import { submitMessage } from "../src/server/public/message-submit.js";

describe("web message submission", () => {
	it("exports the extracted submit operation", () => {
		expect(submitMessage).toBeTypeOf("function");
	});

	it("waits for the active session SSE stream before posting a normal message", async () => {
		vi.mocked(api).mockResolvedValue({ ok: true });
		const waitForSessionStream = vi.fn().mockResolvedValue(true);
		const setRunning = vi.fn();
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef: { current: new Map() },
			waitForSessionStream,
			setRunning,
			showToast: vi.fn(),
		};

		await submitMessage("hello", undefined, undefined, context);

		expect(waitForSessionStream).toHaveBeenCalledWith("session-1");
		expect(api).toHaveBeenCalledWith(
			"POST",
			"/api/sessions/session-1/chat",
			expect.objectContaining({ text: "hello" }),
		);
		// Optimistic Abort — flips before SSE catches up so the composer
		// doesn't leave a disabled Send button hanging for a round trip.
		expect(setRunning).toHaveBeenCalledWith(true);
	});

	it("posts the message even when the event stream is not open yet", async () => {
		// A stream that is still opening used to cancel the send and report
		// "Connection lost" — which is what a new chat on a phone hit every
		// time, since its stream only exists once the session does. The POST is
		// what sends the message; the connect handler refetches the session, so
		// nothing that happens in between is lost.
		vi.mocked(api).mockClear();
		vi.mocked(api).mockResolvedValue({ ok: true });
		const pendingOutgoingRef = { current: new Map() };
		const setRunning = vi.fn();
		const showToast = vi.fn();
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef,
			waitForSessionStream: vi.fn().mockResolvedValue(false),
			selectSession: vi.fn().mockResolvedValue(undefined),
			setRunning,
			showToast,
		};

		await submitMessage("hello", undefined, undefined, context);

		expect(api).toHaveBeenCalledWith(
			"POST",
			"/api/sessions/session-1/chat",
			expect.objectContaining({ text: "hello" }),
		);
		// Sent, so nothing is left queued for a retry and nothing is reported.
		expect(pendingOutgoingRef.current.size).toBe(0);
		expect(showToast).not.toHaveBeenCalled();
		expect(setRunning).toHaveBeenCalledWith(true);
		expect(setRunning).not.toHaveBeenCalledWith(false);
	});

	it("keeps the message for a retry when the post itself fails", async () => {
		vi.mocked(api).mockClear();
		vi.mocked(api).mockRejectedValue(new Error("Failed to fetch"));
		const pendingOutgoingRef = { current: new Map() };
		const setRunning = vi.fn();
		const showToast = vi.fn();
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef,
			waitForSessionStream: vi.fn().mockResolvedValue(true),
			selectSession: vi.fn().mockResolvedValue(undefined),
			setRunning,
			showToast,
		};

		expect(await submitMessage("hello", undefined, undefined, context)).toBe(false);
		expect(pendingOutgoingRef.current.size).toBe(1);
		expect([...pendingOutgoingRef.current.values()][0]).toMatchObject({ text: "hello" });
		expect(setRunning).toHaveBeenLastCalledWith(false);
		expect(showToast).toHaveBeenCalled();
	});

	it("does not answer a pending question while the backend is disconnected", async () => {
		vi.mocked(api).mockClear();
		const showToast = vi.fn();
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [], question: { questions: [{ question: "Name?" }] } },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef: { current: new Map() },
			canSend: () => false,
			showToast,
		};

		await submitMessage("answer", undefined, undefined, context);

		expect(api).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(
			"Connection lost — answer kept in the composer until the daemon reconnects",
			"error",
		);
	});

	it("does not send a draft message when its deferred attachment upload fails", async () => {
		vi.mocked(api).mockClear();
		vi.mocked(api).mockRejectedValueOnce(new Error("upload failed"));
		const showToast = vi.fn();
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef: { current: new Map() },
			setInputsRefreshNonce: vi.fn(),
			setRunning: vi.fn(),
			showToast,
		};

		await submitMessage(
			"attach this\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n- big.zip: (pending — will be uploaded on send)\n</system-reminder>",
			undefined,
			[{ name: "big.zip", dataUrl: "data:application/zip;base64,AAAA" }],
			context,
		);

		expect(showToast).toHaveBeenCalledWith("Failed to upload big.zip: upload failed", "error");
		expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(api)).not.toHaveBeenCalledWith("POST", "/api/sessions/session-1/chat", expect.anything());
	});
});
