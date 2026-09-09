/**
 * Pure text-buffer logic for the Composer — no React, no stdin, no terminal
 * escapes. Exclusively manipulates an internal string + cursor position so
 * it can be unit-tested without rendering anything.
 */
import { findWordBackward, findWordForward } from "./word-nav.ts";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The whole grapheme cluster starting at `pos` — what the cursor cell has to
 * render as one inverse block. Taking a single code point split a family
 * emoji or an accented letter across the cursor and both halves rendered
 * wrong.
 */
export function graphemeAt(text: string, pos: number): string {
	if (pos < 0 || pos >= text.length) return "";
	const window = text.slice(pos, Math.min(text.length, pos + 128));
	for (const { segment } of GRAPHEMES.segment(window)) return segment;
	return "";
}

export class TextBuffer {
	private text = "";
	private cursor = 0;

	get value(): string {
		return this.text;
	}

	get cursorPos(): number {
		return this.cursor;
	}

	get length(): number {
		return this.text.length;
	}

	insert(s: string): void {
		this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
		this.cursor += s.length;
	}

	insertNewline(): void {
		this.insert("\n");
	}

	// The buffer indexes UTF-16 code units, but the cursor must only ever rest
	// on a grapheme-cluster boundary. Stepping or deleting a single unit inside
	// an astral character leaves a lone surrogate — mojibake in the render and
	// in the submitted text — and stepping by *code point* is not enough
	// either: one backspace on a family emoji removed a single member and left
	// a dangling joiner, so the glyph fell apart into separate emoji and it
	// took seven presses to delete what looks like one character. Same for an
	// accent written as a combining mark (`e` + U+0301), and for an emoji with
	// a skin-tone modifier.
	//
	// Boundaries come from Intl.Segmenter, over a window around the cursor
	// rather than the whole buffer: segmenting a long pasted draft costs 49ms
	// at 100KB — on every keystroke — against 0.13ms for the window. A cluster
	// is a handful of units, so a window this wide always contains the one
	// being crossed.
	private static readonly BOUNDARY_WINDOW = 128;

	/** Cluster start offsets (absolute) inside a window of the buffer. */
	private clusterStarts(from: number, to: number): number[] {
		const start = this.snapUnitBoundary(Math.max(0, from));
		const end = this.snapUnitBoundary(Math.min(this.text.length, to));
		const starts: number[] = [];
		for (const { index } of GRAPHEMES.segment(this.text.slice(start, end))) {
			starts.push(start + index);
		}
		return starts;
	}

	/** Nudge off the low half of a surrogate pair, so a window never starts or
	 *  ends inside one (Segmenter would see a lone surrogate). */
	private snapUnitBoundary(pos: number): number {
		if (pos <= 0 || pos >= this.text.length) return pos;
		const code = this.text.charCodeAt(pos);
		return code >= 0xdc00 && code <= 0xdfff ? pos - 1 : pos;
	}

	/** Start of the grapheme cluster before `pos`. */
	private prevBoundary(pos: number): number {
		if (pos <= 0) return 0;
		const starts = this.clusterStarts(pos - TextBuffer.BOUNDARY_WINDOW, pos);
		for (let i = starts.length - 1; i >= 0; i--) {
			if (starts[i]! < pos) return starts[i]!;
		}
		return this.snapUnitBoundary(pos - 1);
	}

	/** Start of the grapheme cluster after `pos`. */
	private nextBoundary(pos: number): number {
		if (pos >= this.text.length) return this.text.length;
		const starts = this.clusterStarts(pos, pos + TextBuffer.BOUNDARY_WINDOW);
		for (const start of starts) {
			if (start > pos) return start;
		}
		return this.text.length;
	}

	backspace(): void {
		if (this.cursor === 0) return;
		const target = this.prevBoundary(this.cursor);
		this.text = this.text.slice(0, target) + this.text.slice(this.cursor);
		this.cursor = target;
	}

	deleteForward(): void {
		if (this.cursor >= this.text.length) return;
		this.text = this.text.slice(0, this.cursor) + this.text.slice(this.nextBoundary(this.cursor));
	}

	moveLeft(): void {
		this.cursor = this.prevBoundary(this.cursor);
	}

	moveRight(): void {
		this.cursor = this.nextBoundary(this.cursor);
	}

	moveLineStart(): void {
		const nl = this.text.lastIndexOf("\n", this.cursor - 1);
		this.cursor = nl === -1 ? 0 : nl + 1;
	}

	moveLineEnd(): void {
		const nl = this.text.indexOf("\n", this.cursor);
		this.cursor = nl === -1 ? this.text.length : nl;
	}

	/** Put the cursor at `pos`, snapped to a grapheme-cluster boundary — what
	 *  moving by *visual* row needs, since the row layout lives in the view. */
	moveTo(pos: number): void {
		const clamped = Math.max(0, Math.min(pos, this.text.length));
		// The end of the buffer is a valid cursor position and not a cluster
		// start, so it can't go through the snapping below.
		if (clamped >= this.text.length) {
			this.cursor = this.text.length;
			return;
		}
		const starts = this.clusterStarts(clamped - TextBuffer.BOUNDARY_WINDOW, clamped + 1);
		let snapped = 0;
		for (const start of starts) {
			if (start <= clamped) snapped = start;
		}
		this.cursor = starts.length > 0 ? snapped : clamped;
	}

	/**
	 * Replace `[from, to)` and leave the cursor after what was inserted — what
	 * Tab-completing a path needs, since it rewrites the token behind the
	 * cursor rather than typing at it.
	 */
	replaceRange(from: number, to: number, insert: string): void {
		const start = Math.max(0, Math.min(from, this.text.length));
		const end = Math.max(start, Math.min(to, this.text.length));
		this.text = this.text.slice(0, start) + insert + this.text.slice(end);
		this.cursor = start + insert.length;
	}

	moveWordLeft(): void {
		this.cursor = findWordBackward(this.text, this.cursor);
	}

	moveWordRight(): void {
		this.cursor = findWordForward(this.text, this.cursor);
	}

	deleteWordBackward(): void {
		if (this.cursor === 0) return;
		const target = findWordBackward(this.text, this.cursor);
		this.text = this.text.slice(0, target) + this.text.slice(this.cursor);
		this.cursor = target;
	}

	deleteWordForward(): void {
		if (this.cursor >= this.text.length) return;
		const target = findWordForward(this.text, this.cursor);
		this.text = this.text.slice(0, this.cursor) + this.text.slice(target);
	}

	deleteToLineStart(): void {
		const lineStart = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
		if (this.cursor === lineStart) return;
		this.text = this.text.slice(0, lineStart) + this.text.slice(this.cursor);
		this.cursor = lineStart;
	}

	deleteToLineEnd(): void {
		const lineEnd = this.text.indexOf("\n", this.cursor);
		if (lineEnd === -1) {
			this.text = this.text.slice(0, this.cursor);
		} else {
			this.text = this.text.slice(0, this.cursor) + this.text.slice(lineEnd);
		}
	}

	clear(): void {
		this.text = "";
		this.cursor = 0;
	}

	setText(text: string): void {
		this.text = text;
		this.cursor = Math.min(this.cursor, text.length);
	}

	getLines(): string[] {
		return this.text.split("\n");
	}

	getCursorLine(): number {
		return this.text.slice(0, this.cursor).split("\n").length - 1;
	}

	getCursorColumn(): number {
		return this.text.slice(0, this.cursor).split("\n").pop()!.length;
	}

	/** Compute lines, cursor line, and cursor column in a single pass. */
	getLayout(): { lines: string[]; cursorLine: number; cursorCol: number } {
		const lines = this.text.split("\n");
		let cursorLine = 0;
		let cursorCol = this.cursor;
		for (let i = 0; i < lines.length; i++) {
			const lineLen = lines[i]!.length;
			if (cursorCol <= lineLen) {
				cursorLine = i;
				break;
			}
			cursorCol -= lineLen + 1; // +1 for the newline
			if (i === lines.length - 1) {
				cursorLine = i;
			}
		}
		return { lines, cursorLine, cursorCol };
	}
}
