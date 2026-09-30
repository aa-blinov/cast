import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/ui/useAgentSession.ts";
import { Transcript } from "../src/ui-pi/transcript.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const base = { streaming: null, error: null, retry: null, showReasoning: false };
const user = (content: string): ChatMessage => ({ role: "user", content });

describe("Transcript", () => {
	it("draws the conversation in order, under the width it is given", () => {
		const transcript = new Transcript();
		transcript.set({
			...base,
			messages: [
				user("hello"),
				{ role: "assistant", content: "", blocks: [{ kind: "content", text: "hi ".repeat(80) }] },
			],
		});
		const rows = transcript.render(50);
		expect(plain(rows[0]!)).toBe("▌ you");
		expect(rows.map(plain)).toContain("▌ agent");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
	});

	it("lays a finished message out once per width, not once per frame", () => {
		const transcript = new Transcript();
		const message = user("cached");
		transcript.set({ ...base, messages: [message] });
		const first = transcript.render(60);
		const second = transcript.render(60);
		expect(second).toEqual(first);
		expect(transcript.render(30)).toHaveLength(first.length);
	});

	it("shows one activity row while a turn streams with nothing running, and none once a tool runs", () => {
		const transcript = new Transcript();
		transcript.set({
			...base,
			messages: [],
			streaming: { blocks: [{ kind: "content", text: "thinking out loud" }] },
		});
		const waiting = transcript.render(60).map(plain);
		expect(waiting.at(-1)).toMatch(/^│ [⠋-⠿]$/);
		transcript.set({
			...base,
			messages: [],
			streaming: {
				blocks: [{ kind: "tool", call: { id: "t", name: "bash", args: '{"command":"ls"}', status: "running" } }],
			},
		});
		expect(
			transcript
				.render(60)
				.map(plain)
				.some((row) => /^│ [⠋-⠿]$/.test(row)),
		).toBe(false);
	});

	it("puts a blank row wherever the speaker changes, and none between two turns of the agent", () => {
		const agent = (text: string): ChatMessage => ({
			role: "assistant",
			content: "",
			blocks: [{ kind: "content", text }],
		});
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [user("q"), agent("a"), agent("b"), user("q2")] });
		const rows = transcript.render(60).map((row) => plain(row).trimEnd());
		expect(rows).toEqual(["▌ you", "▌ q", "", "▌ agent", "▌ a", "▌ agent", "▌ b", "", "▌ you", "▌ q2"]);
	});

	it("sets the person's turn on a band as wide as the screen", () => {
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [user("hi")] });
		const rows = transcript.render(40);
		expect(visibleWidth(rows[1]!)).toBe(40);
	});

	it("shows an error and a retry notice ahead of the live answer", () => {
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [], error: "provider down", retry: { attempt: 2, reason: "timeout" } });
		const rows = transcript.render(80).map(plain);
		expect(rows).toContain("│ provider down");
		expect(rows).toContain("│ Retrying (attempt 2): timeout");
	});
});
