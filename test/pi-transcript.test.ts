import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/ui/useAgentSession.ts";
import { MAX_MEASURE, Transcript } from "../src/ui-pi/transcript.ts";

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
		expect(rows.map(plain).slice(0, 3)).toEqual(["", "YOU", "    hello"]);
		expect(rows.map(plain)).toContain("AGENT");
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
		expect(waiting.at(-1)).toMatch(/^ {2}[⠋-⠿]$/);
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
				.some((row) => /^ {2}[⠋-⠿]$/.test(row)),
		).toBe(false);
	});

	it("opens every section with a blank row and its own heading, and puts no stripe down the side", () => {
		const agent = (text: string): ChatMessage => ({
			role: "assistant",
			content: "",
			blocks: [{ kind: "content", text }],
		});
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [user("q"), agent("a"), user("q2")] });
		const rows = transcript.render(60).map((row) => plain(row).trimEnd());
		expect(rows).toEqual(["", "YOU", "    q", "", "AGENT", "    a", "", "YOU", "    q2"]);
		expect(rows.join("")).not.toMatch(/[▌┆│]/);
	});

	it("does not paint a band behind the person's turn, whatever the terminal says about its colours", () => {
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [user("hi")] });
		const rows = transcript.render(40);
		expect(rows.some((row) => row.includes("\x1b[48"))).toBe(false);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThan(40);
	});

	it("keeps prose to a readable measure on a wide terminal, and uses the whole width on a narrow one", () => {
		const transcript = new Transcript();
		transcript.set({
			...base,
			messages: [
				user("hello"),
				{ role: "assistant", content: "", blocks: [{ kind: "content", text: "word ".repeat(200) }] },
			],
		});
		const widest = (width: number) => Math.max(...transcript.render(width).map((row) => visibleWidth(row)));
		expect(widest(240)).toBeLessThanOrEqual(MAX_MEASURE);
		expect(widest(240)).toBeGreaterThan(MAX_MEASURE - 12);
		expect(widest(60)).toBeLessThanOrEqual(60);
		expect(widest(60)).toBeGreaterThan(48);
	});

	it("shows an error and a retry notice ahead of the live answer", () => {
		const transcript = new Transcript();
		transcript.set({ ...base, messages: [], error: "provider down", retry: { attempt: 2, reason: "timeout" } });
		const rows = transcript.render(80).map(plain);
		expect(rows).toContain("  ✗ provider down");
		expect(rows).toContain("    Retrying (attempt 2): timeout");
	});
});
