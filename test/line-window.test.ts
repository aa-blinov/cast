/**
 * The composer draws one row whatever the draft: a wrapped long draft grew
 * Ink's live region past the terminal, and Ink pays for that by clearing the
 * screen and the scrollback on every frame (13 full clears while typing one
 * 600-character line at 100 columns, before this window existed).
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ui/display-width.ts";
import { lineWindow } from "../src/ui/input/line-window.ts";
import { chipCharFor, pasteLabel } from "../src/ui/paste.ts";

const CELLS = 40;
const plain = (cluster: string) => displayWidth(cluster);
const visibleWidth = (line: string, cursor: number, cells = CELLS, width = plain) => {
	const win = lineWindow(line, cursor, cells, width);
	return { win, width: displayWidth(line.slice(win.start, win.end)) };
};

describe("lineWindow", () => {
	it("shows a short draft whole, with no edge markers", () => {
		const line = "short draft";
		const win = lineWindow(line, line.length, CELLS, plain);
		expect([win.start, win.end]).toEqual([0, line.length]);
		expect(win.clippedLeft).toBe(false);
		expect(win.clippedRight).toBe(false);
	});

	it("keeps the tail visible while typing at the end of a long draft", () => {
		const line = "x".repeat(500);
		const { win, width } = visibleWidth(line, line.length);
		expect(width).toBeLessThanOrEqual(CELLS);
		expect(win.end).toBe(line.length);
		expect(win.clippedLeft).toBe(true);
		expect(win.clippedRight).toBe(false);
	});

	it("keeps the cursor inside the window when it sits mid-draft, with lookahead", () => {
		const line = "y".repeat(500);
		const cursor = 250;
		const { win, width } = visibleWidth(line, cursor);
		expect(width).toBeLessThanOrEqual(CELLS);
		expect(win.start).toBeLessThanOrEqual(cursor);
		expect(win.end).toBeGreaterThan(cursor);
		expect(win.clippedLeft && win.clippedRight).toBe(true);
	});

	it("measures cells, not characters — wide text fills the row with fewer of them", () => {
		const line = "日本語のテキストです".repeat(50);
		const { win, width } = visibleWidth(line, line.length);
		expect(width).toBeLessThanOrEqual(CELLS);
		// Two cells apiece: about half as many characters as an ASCII draft.
		expect(win.end - win.start).toBeLessThanOrEqual(CELLS / 2);
	});

	it("charges a chip its whole label, not the one column it occupies", () => {
		const chip = chipCharFor(0);
		const label = pasteLabel(40, 4000);
		const line = `before ${chip.repeat(6)}`;
		const width = (cluster: string) => (cluster === chip ? displayWidth(label) : displayWidth(cluster));
		const win = lineWindow(line, line.length, CELLS, width);
		const rendered = [...line.slice(win.start, win.end)].reduce((sum, ch) => sum + width(ch), 0);
		expect(rendered).toBeLessThanOrEqual(CELLS);
		// 6 chips at 17 cells each cannot all fit — the window has to clip.
		expect(win.clippedLeft).toBe(true);
	});

	it("never cuts inside a grapheme cluster", () => {
		const family = "👨‍👩‍👧‍👦";
		const line = family.repeat(30);
		const win = lineWindow(line, line.length, CELLS, plain);
		const slice = line.slice(win.start, win.end);
		expect(slice.length % family.length).toBe(0);
		expect(slice.includes("‍‍")).toBe(false);
		expect(displayWidth(slice)).toBeLessThanOrEqual(CELLS);
	});

	it("clamps a cursor outside the buffer instead of returning a broken window", () => {
		const line = "abc";
		expect(lineWindow(line, 99, CELLS, plain)).toMatchObject({ start: 0, end: 3 });
		expect(lineWindow(line, -5, CELLS, plain)).toMatchObject({ start: 0, end: 3 });
		expect(lineWindow("", 0, CELLS, plain)).toMatchObject({ start: 0, end: 0 });
	});
});
