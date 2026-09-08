import { describe, expect, it } from "vitest";
import { clampStreamingBlocks } from "../src/ui/ChatLog.tsx";
import { displayWidth } from "../src/ui/display-width.ts";
import type { StreamBlock } from "../src/ui/useAgentSession.ts";

const text = (kind: "thinking" | "content", t: string): StreamBlock => ({ kind, text: t }) as StreamBlock;
const tool = (id: string): StreamBlock =>
	({ kind: "tool", call: { id, name: "bash", args: "{}", status: "running" } }) as StreamBlock;

describe("clampStreamingBlocks", () => {
	/**
	 * A live region taller than the viewport is what Ink cannot erase: it falls
	 * back to clearing the terminal and replaying all of its static output, on
	 * every frame. The clamp is what prevents that, and it now counts the rows
	 * it is about to render rather than estimating cells — the estimate is
	 * where a CJK answer used to take twice the rows it was allowed.
	 */
	const rows = (out: ReturnType<typeof clampStreamingBlocks>): number =>
		out.reduce(
			(total, entry) =>
				total + (entry.block.kind === "tool" ? 1 : (entry.lines?.length ?? 0) + (entry.block.continued ? 0 : 1)),
			0,
		);
	const renderedText = (entry: ReturnType<typeof clampStreamingBlocks>[number]): string =>
		(entry.lines ?? []).map((line) => line.spans.map((span) => span.text).join("")).join("\n");
	const widestLine = (entry: ReturnType<typeof clampStreamingBlocks>[number]): number =>
		Math.max(0, ...(entry.lines ?? []).map((line) => displayWidth(line.spans.map((span) => span.text).join(""))));

	it.each([
		["ascii", "x"],
		["CJK", "日"],
		["emoji", "\u{1f600}"],
		["combining", "é"],
	])("keeps one long %s line inside the row budget", (_name, char) => {
		const blocks = [text("content", char.repeat(20_000))];

		const out = clampStreamingBlocks(blocks, 24, 80);

		expect(out).toHaveLength(1);
		expect(out[0]!.truncated).toBe(true);
		// budget = 24 - 8 = 16 rows, and every line fits the width in cells
		expect(rows(out)).toBeLessThanOrEqual(16);
		expect(widestLine(out[0]!)).toBeLessThanOrEqual(80);
	});

	it("keeps the tail of a wide-character line, not its head", () => {
		const line = `${"日".repeat(5_000)}THE-END`;

		const out = clampStreamingBlocks([text("content", line)], 24, 80);

		expect(renderedText(out[0]!).trimEnd().endsWith("THE-END")).toBe(true);
		expect(rows(out)).toBeLessThanOrEqual(16);
	});

	it("passes through blocks that fit the viewport", () => {
		const blocks = [text("thinking", "short"), tool("t1"), text("content", "also short")];
		const out = clampStreamingBlocks(blocks, 24, 80);
		expect(out).toHaveLength(3);
		expect(out.every((b) => !b.truncated)).toBe(true);
		expect(out.map((b) => b.block)).toEqual(blocks);
	});

	it("keeps only the tail lines of a block taller than the viewport", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const blocks = [text("thinking", lines.join("\n"))];
		const out = clampStreamingBlocks(blocks, 24, 80);
		expect(out).toHaveLength(1);
		expect(out[0]!.truncated).toBe(true);
		const kept = renderedText(out[0]!)
			.split("\n")
			.map((l) => l.trim());
		// budget = 24 - 8 = 16 rows, one of them the block's header
		expect(rows(out)).toBeLessThanOrEqual(16);
		// tail is kept, not the head
		expect(kept.at(-1)).toBe("line 99");
		expect(kept[0]).not.toBe("line 0");
	});

	it("accounts for line wrapping at narrow widths", () => {
		// one logical line of 400 chars at 40 cols ≈ 10 rows
		const long = "x".repeat(400);
		const blocks = [text("content", `${long}\n${long}\n${long}`)]; // ~30 rows
		const out = clampStreamingBlocks(blocks, 20, 40); // budget 12
		expect(out[0]!.truncated).toBe(true);
	});

	it("hard-cuts a single wrapped line longer than the whole budget", () => {
		const blocks = [text("content", "y".repeat(10_000))];
		const out = clampStreamingBlocks(blocks, 14, 50); // budget 6 → 300 chars
		expect(out[0]!.truncated).toBe(true);
		expect(rows(out)).toBeLessThanOrEqual(6);
		expect(widestLine(out[0]!)).toBeLessThanOrEqual(50);
	});

	it("drops older blocks entirely once the budget is spent", () => {
		const tall = Array.from({ length: 50 }, (_, i) => `t${i}`).join("\n");
		const blocks = [text("thinking", tall), tool("t1"), text("content", tall)];
		const out = clampStreamingBlocks(blocks, 24, 80);
		// trailing content block eats the whole budget; older blocks dropped
		expect(out.length).toBeLessThan(3);
		expect(out.at(-1)!.block.kind).toBe("content");
	});

	it("never returns an empty list for non-empty input on tiny terminals", () => {
		const blocks = [text("content", "hello\nworld")];
		const out = clampStreamingBlocks(blocks, 5, 80); // budget clamps to min 4
		expect(out).toHaveLength(1);
	});

	it("reports each block's index in the input array", () => {
		const blocks = [text("thinking", "a"), tool("t1"), text("content", "b")];
		const out = clampStreamingBlocks(blocks, 24, 80);
		expect(out.map((e) => e.index)).toEqual([0, 1, 2]);
	});

	it("keeps input indices when older blocks are dropped", () => {
		const tall = Array.from({ length: 50 }, (_, i) => `t${i}`).join("\n");
		const blocks = [text("thinking", tall), tool("t1"), text("content", tall)];
		const out = clampStreamingBlocks(blocks, 24, 80);
		// whatever survives, its index must point back into `blocks`
		for (const e of out) {
			expect(blocks[e.index]!.kind).toBe(e.block.kind);
		}
		expect(out.at(-1)!.index).toBe(2);
	});

	it("counts wide (CJK) characters as two columns when wrapping", () => {
		// 30 CJK chars = 60 display columns → 2 rows at 40 cols, ~16 such lines
		// exceed the 12-row budget even though each line is only 30 code units.
		const wideLine = "あ".repeat(30);
		const blocks = [text("content", Array.from({ length: 16 }, () => wideLine).join("\n"))];
		const out = clampStreamingBlocks(blocks, 20, 40); // budget 12
		expect(out[0]!.truncated).toBe(true);
	});

	it("keeps multiple parallel long task tools visible (1 row each while live)", () => {
		const long = "Explore the module tree in great detail and report structure. ".repeat(12);
		const task = (id: string): StreamBlock =>
			({
				kind: "tool",
				call: {
					id,
					name: "task",
					args: JSON.stringify({ subagent: "explore", assignment: long }),
					status: "running",
				},
			}) as StreamBlock;
		const blocks = [task("a"), task("b"), task("c")];
		const out = clampStreamingBlocks(blocks, 24, 80); // budget 16
		expect(out).toHaveLength(3);
		expect(out.map((e) => (e.block.kind === "tool" ? e.block.call.id : ""))).toEqual(["a", "b", "c"]);
	});
});
