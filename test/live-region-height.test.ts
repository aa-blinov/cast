/**
 * The clamp counts the rows it hands to the view; the view must not add any.
 *
 * It did once: the truncation marker was appended to the speaker label
 * (`agent …`), making the row two cells wider than the width its lines were
 * rendered for. Ink then wrapped every line of the block, the live region
 * doubled in height, and Ink fell back to clearing the terminal and replaying
 * all of its static output on every frame — 63 full-screen clears in one
 * streaming answer, which is precisely the failure the clamp exists to
 * prevent.
 */
import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChatLog, clampStreamingBlocks } from "../src/ui/ChatLog.tsx";
import { displayWidth } from "../src/ui/display-width.ts";
import type { StreamBlock } from "../src/ui/useAgentSession.ts";

const COLUMNS = 100;
const ROWS = 30;

const frameRows = (blocks: StreamBlock[]): { rows: number; widest: number } => {
	const output = renderToString(
		createElement(ChatLog, {
			messages: [],
			streaming: { blocks },
			error: null,
			retry: null,
			columns: COLUMNS,
			repaintKey: 0,
			showReasoning: true,
		}),
		// Without this Ink renders at its default width and wraps rows that fit
		// the real terminal, which would make this measure the harness.
		{ columns: COLUMNS },
	);
	const lines = output
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes Ink emits
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	return { rows: lines.length, widest: Math.max(...lines.map(displayWidth)) };
};

describe("live region height", () => {
	it.each([
		["CJK", "日本語のテキストです".repeat(400)],
		["ascii", "the quick brown fox jumps over the lazy dog ".repeat(400)],
		["one long word", "x".repeat(8000)],
		["many short lines", Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")],
	])("renders a truncated %s block no taller than the clamp charged", (_name, text) => {
		const blocks = [{ kind: "content", text } as StreamBlock];

		const laidOut = clampStreamingBlocks(blocks, ROWS, COLUMNS);
		const charged = laidOut.reduce(
			(total, entry) => total + (entry.block.kind === "tool" ? 1 : (entry.lines?.length ?? 0)),
			0,
		);
		const { rows, widest } = frameRows(blocks);

		expect(laidOut[0]!.truncated, "the block must be big enough to be clamped").toBe(true);
		// +1 for the spinner row ChatLog adds when no tool is running.
		expect(rows).toBeLessThanOrEqual(charged + 1);
		// No row may reach the terminal's width, or the terminal wraps it and
		// the frame is taller than either side counted.
		expect(widest).toBeLessThanOrEqual(COLUMNS);
	});

	it("keeps a reasoning block within its charge too", () => {
		const blocks = [{ kind: "thinking", text: "日本語のテキストです".repeat(300) } as StreamBlock];

		const charged = clampStreamingBlocks(blocks, ROWS, COLUMNS).reduce(
			(total, entry) => total + (entry.lines?.length ?? 0),
			0,
		);

		expect(frameRows(blocks).rows).toBeLessThanOrEqual(charged + 1);
	});
});
