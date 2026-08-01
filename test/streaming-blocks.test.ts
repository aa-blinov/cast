import { describe, expect, it } from "vitest";
import { type StreamBlock, settledPrefixLength, splitCompleteLines } from "../src/ui/useAgentSession.ts";
import { appendTextBlock, blocksFromAssistantCompletion, reduceStreamEvent } from "../src/web/public/stream-blocks.js";

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

describe("splitCompleteLines", () => {
	it("leaves a block with no newline untouched", () => {
		const { settled, tail } = splitCompleteLines(content("still typing"));
		expect(settled).toEqual([]);
		expect(tail).toEqual(content("still typing"));
	});

	it("splits off complete lines, keeping the partial last line live", () => {
		const { settled, tail } = splitCompleteLines(content("line one\nline two\npartial"));
		expect(settled).toEqual([{ kind: "content", text: "line one\nline two", continued: undefined }]);
		expect(tail).toEqual({ kind: "content", text: "partial", continued: true });
	});

	it("marks the settled piece as continued once the run already showed its label", () => {
		const running = content("partial");
		(running as { continued?: boolean }).continued = true;
		const { settled, tail } = splitCompleteLines({ ...running, text: "partial\nmore" });
		expect(settled).toEqual([{ kind: "content", text: "partial", continued: true }]);
		expect(tail).toEqual({ kind: "content", text: "more", continued: true });
	});

	it("never splits a tool block", () => {
		const t = tool("running");
		expect(splitCompleteLines(t)).toEqual({ settled: [], tail: t });
	});

	it("keeps multi-paragraph reasoning as one logical block", () => {
		const reasoning = think("First paragraph.\n\nSecond paragraph.");
		expect(splitCompleteLines(reasoning)).toEqual({ settled: [], tail: reasoning });
	});
});

describe("appendText", () => {
	it("merges into the trailing block of the same kind", () => {
		expect(appendTextBlock([content("Hel")], "content", "lo")).toEqual([content("Hello")]);
	});

	it("starts a new block when the kind switches, marking the previous as settled", () => {
		// The previous content block gets continued:false so it renders its label,
		// instead of bleeding into the next block's label line.
		const prev = { ...content("answering"), continued: false };
		expect(appendTextBlock([content("answering")], "thinking", "hmm")).toEqual([prev, think("hmm")]);
	});

	it("marks a continued (streaming) block as settled when a different kind starts", () => {
		// The trailing tail of a thinking stream was continued:true (no label
		// shown so far). When content begins, the thinking tail settles so its
		// last line gets its [reasoning] label back — otherwise that letter
		// runs straight into [agent] on the next line.
		const settledTail = { ...think("last word"), continued: false };
		expect(appendTextBlock([think("last word")], "content", "answer")).toEqual([settledTail, content("answer")]);
	});

	it("merges back into an earlier same-kind block across intervening thinking (MiniMax-M2 interleaving)", () => {
		const blocks = [content("Привет! Я помогу с пит"), think("...")];
		expect(appendTextBlock(blocks, "content", "чами")).toEqual([content("Привет! Я помогу с питчами"), think("...")]);
	});

	it("does not merge across a tool call boundary", () => {
		const blocks = [content("before"), tool("ok")];
		expect(appendTextBlock(blocks, "content", "after")).toEqual([content("before"), tool("ok"), content("after")]);
	});

	it("keeps a reasoning run intact across an ambiguous whitespace content delta", () => {
		const initial = reduceStreamEvent({ blocks: [] }, { type: "thinking", text: "First reasoning chunk." });
		const buffered = reduceStreamEvent(initial, { type: "content", text: "\n\n" });
		const combined = reduceStreamEvent(buffered, { type: "thinking", text: " Second reasoning chunk." });
		expect(buffered).toEqual({ blocks: [think("First reasoning chunk.")], pendingContentWhitespace: "\n\n" });
		expect(combined).toEqual({ blocks: [think("First reasoning chunk. Second reasoning chunk.")] });
	});

	it("keeps buffered whitespace when visible content confirms the answer has started", () => {
		const initial = reduceStreamEvent({ blocks: [think("Reasoning done.")] }, { type: "content", text: "\n\n" });
		const answer = reduceStreamEvent(initial, { type: "content", text: "Answer." });
		expect(answer).toEqual({
			blocks: [{ ...think("Reasoning done."), continued: false }, content("\n\nAnswer.")],
		});
	});
});

describe("blocksFromAssistantCompletion", () => {
	it("keeps the assistant reply above the tool calls that it initiates", () => {
		expect(
			blocksFromAssistantCompletion({
				thinking: "I should inspect the machine.",
				content: "Сейчас посмотрю подробности.",
				toolCalls: [{ id: "call-1", name: "bash", arguments: "uname -a" }],
			}),
		).toEqual([
			think("I should inspect the machine."),
			content("Сейчас посмотрю подробности."),
			{
				kind: "tool",
				call: { id: "call-1", name: "bash", args: "uname -a", status: "ok" },
			},
		]);
	});
});
