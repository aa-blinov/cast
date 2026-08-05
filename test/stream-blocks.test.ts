import { describe, expect, it } from "vitest";
import { appendTextBlock } from "../src/web/public/stream-blocks.js";

describe("appendTextBlock — reasoning live-region height", () => {
	// Background: a single thinking block can grow to thousands of chars per
	// turn. The TUI's scroll guard (useTerminalResync) disables its DECXCPR
	// cursor poll once the live region exceeds the viewport, because the
	// natural cursor-below-viewport position looks like a user scroll. With
	// poll disabled and a user-initiated scroll, Ink's CUU+erase redraws land
	// at the wrong rows and the visible content "jumps". splitThinkingAt caps
	// the active thinking block at a char threshold so the live region stays
	// within the viewport and the poll keeps running. Older reasoning text
	// moves into <Static> as a settled (continued: false) sibling.

	const SMALL_CHUNK = "x".repeat(200);
	const BIG_CHUNK = "x".repeat(2000);

	it("keeps small reasoning as a single block (no split needed)", () => {
		let blocks = appendTextBlock([], "thinking", SMALL_CHUNK);
		blocks = appendTextBlock(blocks, "thinking", " more");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind).toBe("thinking");
	});

	it("splits a thinking block when the new text exceeds the cap", () => {
		// Seed a small thinking block, then a large delta that pushes the
		// active block past SPLIT_REASONING_CHARS. Expect: 1 settled
		// (continued: false) + 1 active (continued: true) thinking block.
		let blocks = appendTextBlock([], "thinking", "head ");
		blocks = appendTextBlock(blocks, "thinking", BIG_CHUNK);
		const thinkingBlocks = blocks.filter((b) => b.kind === "thinking");
		expect(thinkingBlocks.length).toBeGreaterThanOrEqual(2);
		// At least one settled (continued: false) — the old head drained.
		expect(thinkingBlocks.some((b) => b.continued === false)).toBe(true);
		// The active (last) block is continued: true, signalling the stream
		// is still open and a tail merge is in progress.
		const last = thinkingBlocks.at(-1)!;
		expect(last.continued).toBe(true);
	});

	it("splits a first thinking event that's already over the cap", () => {
		// Real MiniMax streams often arrive as a single big thinking delta
		// before any prior block exists — the merge path can't fire (nothing
		// to merge into). The new-block path must also split, otherwise the
		// active block stays > cap and clampStreamingBlocks has to truncate
		// the visible tail of an already-too-tall block.
		const blocks = appendTextBlock([], "thinking", BIG_CHUNK);
		const thinkingBlocks = blocks.filter((b) => b.kind === "thinking");
		expect(thinkingBlocks).toHaveLength(2);
		expect(thinkingBlocks[0]!.continued).toBe(false);
		expect(thinkingBlocks[1]!.continued).toBe(true);
		expect(thinkingBlocks[1]!.text.length).toBeLessThanOrEqual(1500);
		expect(thinkingBlocks[0]!.text.length).toBe(BIG_CHUNK.length - thinkingBlocks[1]!.text.length);
	});

	it("caps the active thinking block so the live region stays bounded", () => {
		// A burst of 5x BIG_CHUNK should produce at most 5 active splits
		// (1 settled per split) — and the active block must be ≤ the cap.
		let blocks = appendTextBlock([], "thinking", "head ");
		for (let i = 0; i < 5; i++) {
			blocks = appendTextBlock(blocks, "thinking", BIG_CHUNK);
		}
		const settledCount = blocks.filter((b) => b.kind === "thinking" && b.continued === false).length;
		const active = blocks.filter((b) => b.kind === "thinking" && b.continued === true);
		expect(active).toHaveLength(1);
		// Every active-text length stays bounded; settled text absorbs the rest.
		expect(active[0]!.text.length).toBeLessThanOrEqual(1500);
		expect(settledCount).toBeGreaterThanOrEqual(3);
	});

	it("preserves the full text across splits (no data loss)", () => {
		// Joining all thinking blocks' text in order must equal the
		// concatenation of every chunk appended, with no gaps or duplication.
		const chunks = ["alpha ", "beta ", "gamma ", "delta "];
		let blocks: Array<{ kind: string; text: string; continued?: boolean }> = [];
		for (const c of chunks) {
			blocks = appendTextBlock(blocks, "thinking", c);
		}
		// Add a big delta to force splits.
		blocks = appendTextBlock(blocks, "thinking", BIG_CHUNK);
		// Add more to verify the chain keeps merging into the active block.
		blocks = appendTextBlock(blocks, "thinking", " omega");
		const joined = blocks
			.filter((b) => b.kind === "thinking")
			.map((b) => b.text)
			.join("");
		const expected = `${chunks.join("")}${BIG_CHUNK} omega`;
		expect(joined).toBe(expected);
	});

	it("does not split content blocks (only thinking)", () => {
		// content is already drained by splitCompleteLines via newlines; the
		// split-on-char-boundary logic must NOT apply to it.
		let blocks = appendTextBlock([], "content", "head ");
		blocks = appendTextBlock(blocks, "content", BIG_CHUNK);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind).toBe("content");
	});

	it("does not split when crossing into a different kind (last settled)", () => {
		// The last block in a different kind already drains to Static via the
		// existing settledLast logic; we must not produce a 2nd settled here.
		let blocks = appendTextBlock([], "thinking", "first ");
		blocks = appendTextBlock(blocks, "content", "agent ");
		blocks = appendTextBlock(blocks, "thinking", BIG_CHUNK);
		// Expect 1 content + 1 settled thinking + 1 active thinking.
		expect(blocks.filter((b) => b.kind === "thinking")).toHaveLength(2);
		expect(blocks.filter((b) => b.kind === "content")).toHaveLength(1);
	});
});
