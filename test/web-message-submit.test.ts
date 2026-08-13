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
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef: { current: new Map() },
			waitForSessionStream,
			showToast: vi.fn(),
		};

		await submitMessage("hello", undefined, undefined, context);

		expect(waitForSessionStream).toHaveBeenCalledWith("session-1");
		expect(api).toHaveBeenCalledWith(
			"POST",
			"/api/sessions/session-1/chat",
			expect.objectContaining({ text: "hello" }),
		);
	});

	it("hydrates the session when the SSE waiter times out after the daemon accepts", async () => {
		vi.mocked(api).mockResolvedValue({ ok: true });
		const selectSession = vi.fn().mockResolvedValue(undefined);
		const context = {
			planRefineArmedRef: { current: false },
			session: { id: "session-1", messages: [] },
			draftVersionRef: { current: 0 },
			activeId: "session-1",
			setSession: vi.fn(),
			pendingOutgoingRef: { current: new Map() },
			waitForSessionStream: vi.fn().mockResolvedValue(false),
			selectSession,
			showToast: vi.fn(),
		};

		await submitMessage("hello", undefined, undefined, context);

		expect(selectSession).toHaveBeenCalledWith("session-1", { push: false });
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
