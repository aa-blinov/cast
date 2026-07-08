import { describe, expect, it } from "vitest";
import { type StreamBlock, settledPrefixLength } from "../src/ui/useAgentSession.ts";

const think = (text: string): StreamBlock => ({ kind: "thinking", text });
const content = (text: string): StreamBlock => ({ kind: "content", text });
const tool = (status: "running" | "ok" | "error"): StreamBlock => ({
	kind: "tool",
	call: { id: "t1", name: "bash", args: "{}", status },
});

describe("settledPrefixLength", () => {
	it("never settles the trailing text block — it's still streaming", () => {
		expect(settledPrefixLength([content("hi")])).toBe(0);
		expect(settledPrefixLength([think("thinking...")])).toBe(0);
	});

	it("settles a text/reasoning block once a later block exists", () => {
		// reasoning is done once content starts after it; content stays live
		expect(settledPrefixLength([think("done"), content("now answering")])).toBe(1);
	});

	it("keeps a running tool live (and everything after it)", () => {
		expect(settledPrefixLength([content("calling"), tool("running")])).toBe(1); // text drains, tool stays
		expect(settledPrefixLength([tool("running")])).toBe(0);
	});

	it("settles a finished tool even when it's the last block", () => {
		expect(settledPrefixLength([tool("ok")])).toBe(1);
		expect(settledPrefixLength([tool("error")])).toBe(1);
	});

	it("drains a contiguous finished prefix but stops at the first unsettled block", () => {
		const blocks = [think("a"), content("b"), tool("ok"), content("c")];
		// think(non-last), content(non-last), tool(ok) all settled; trailing content stays live
		expect(settledPrefixLength(blocks)).toBe(3);
	});

	it("stops at a running tool even if earlier blocks are settled", () => {
		const blocks = [think("a"), tool("running"), content("b")];
		expect(settledPrefixLength(blocks)).toBe(1);
	});

	it("returns 0 for an empty turn", () => {
		expect(settledPrefixLength([])).toBe(0);
	});
});
