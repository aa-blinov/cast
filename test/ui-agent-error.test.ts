import { describe, expect, it } from "vitest";
import { commitTurnError } from "../src/ui/useAgentSession.ts";

describe("commitTurnError", () => {
	it("commits the stashed error to the transcript as a warning row and clears the live error", () => {
		const errorRef = { current: "API key rejected (401) — it may be revoked, expired, or incorrect." };
		let liveError: string | null = errorRef.current;
		let messages: unknown[] = [];
		const setError = (v: string | null) => {
			liveError = v;
		};
		const setMessages = (updater: (msgs: unknown[]) => unknown[]) => {
			messages = updater(messages);
		};

		commitTurnError(errorRef, setError, setMessages);

		expect(liveError).toBeNull();
		expect(errorRef.current).toBeNull();
		expect(messages).toEqual([
			{ role: "warning", content: "[API key rejected (401) — it may be revoked, expired, or incorrect.]" },
		]);
	});

	it("clears without appending when no error message was stashed", () => {
		const errorRef = { current: null };
		let liveError: string | null = null;
		let messages: unknown[] = [];
		const setError = (v: string | null) => {
			liveError = v;
		};
		const setMessages = (updater: (msgs: unknown[]) => unknown[]) => {
			messages = updater(messages);
		};

		commitTurnError(errorRef, setError, setMessages);

		expect(liveError).toBeNull();
		expect(errorRef.current).toBeNull();
		expect(messages).toEqual([]);
	});
});
