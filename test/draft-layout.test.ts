/**
 * A long request must wrap like text anywhere else — and stop growing, because
 * the composer sits in Ink's live region and a region taller than the terminal
 * costs the screen and the scrollback on every frame.
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ui/display-width.ts";
import { layoutDraft } from "../src/ui/input/draft-layout.ts";
import { chipCharFor, pasteLabel } from "../src/ui/paste.ts";

const CELLS = 20;
const plain = (cluster: string) => displayWidth(cluster);
const rowTexts = (text: string, cursor = text.length, cells = CELLS, width = plain) =>
	layoutDraft(text, cursor, cells, width).rows.map((row) => text.slice(row.from, row.to));

describe("layoutDraft", () => {
	it("keeps a short draft on one row", () => {
		const { rows, cursorRow } = layoutDraft("short", 5, CELLS, plain);
		expect(rows).toHaveLength(1);
		expect(cursorRow).toBe(0);
		expect(rows[0]).toMatchObject({ from: 0, to: 5, first: true });
	});

	it("wraps at spaces, never mid-word, and no row is wider than the budget", () => {
		const text = "перенеси эту строку по словам аккуратно";
		const rows = rowTexts(text);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(CELLS);
		// Every word survives whole somewhere.
		for (const word of text.split(" ")) expect(rows.some((row) => row.includes(word))).toBe(true);
	});

	it("breaks mid-word only when the word cannot fit a row at all", () => {
		const rows = rowTexts("x".repeat(45));
		expect(rows.map((row) => row.length)).toEqual([20, 20, 5]);
	});

	it("measures cells, so wide characters wrap sooner", () => {
		const rows = rowTexts("日本語のテキストです".repeat(3));
		for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(CELLS);
		// Ten two-cell characters fill a 20-cell row exactly.
		expect(rows[0]).toBe("日本語のテキストです");
	});

	it("charges a chip its whole label", () => {
		const chip = chipCharFor(0);
		const label = pasteLabel(40, 4000);
		const width = (cluster: string) => (cluster === chip ? displayWidth(label) : displayWidth(cluster));
		const text = `смотри ${chip}`;
		const rows = layoutDraft(text, text.length, CELLS, width).rows;
		// "смотри " is 7 cells, the chip's label 17 — they cannot share a row.
		expect(rows).toHaveLength(2);
		expect(text.slice(rows[1]!.from, rows[1]!.to)).toBe(chip);
	});

	it("gives every buffer line a row, including empty ones", () => {
		expect(rowTexts("a\n\nb")).toEqual(["a", "", "b"]);
		expect(rowTexts("")).toEqual([""]);
		expect(layoutDraft("a\n\nb", 2, CELLS, plain).cursorRow).toBe(1);
	});

	it("puts the cursor on the row it will type into", () => {
		const text = "перенеси эту строку по словам аккуратно";
		const { rows, cursorRow } = layoutDraft(text, text.length, CELLS, plain);
		expect(cursorRow).toBe(rows.length - 1);
		// At a wrap point the cursor belongs to the later row.
		const wrapped = layoutDraft(text, rows[1]!.from, CELLS, plain);
		expect(wrapped.cursorRow).toBe(1);
		expect(layoutDraft(text, 0, CELLS, plain).cursorRow).toBe(0);
	});

	it("clamps a cursor outside the buffer", () => {
		expect(layoutDraft("abc", 99, CELLS, plain).cursorRow).toBe(0);
		expect(layoutDraft("abc", -5, CELLS, plain).cursorRow).toBe(0);
	});
});
