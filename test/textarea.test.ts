import { describe, expect, it } from "vitest";
import { graphemeAt, TextBuffer } from "../src/ui/input/textarea.ts";

describe("TextBuffer", () => {
	/**
	 * One keypress has to delete one *glyph*. Stepping by code point left a
	 * dangling joiner behind, so a family emoji fell apart into its members
	 * and took seven backspaces to remove; an accent written as a combining
	 * mark came off its letter.
	 */
	describe("grapheme clusters", () => {
		const CLUSTERS: Array<[string, string]> = [
			["family emoji", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}"],
			["skin tone", "\u{1f44d}\u{1f3fd}"],
			["combining accent", "e\u0301"],
			["regional flag", "\u{1f1fa}\u{1f1f8}"],
			["astral emoji", "\u{1f600}"],
			["wide CJK", "日"],
		];

		it.each(CLUSTERS)("backspace removes a whole %s", (_name, cluster) => {
			const buf = new TextBuffer();
			buf.insert(`ab${cluster}`);

			buf.backspace();

			expect(buf.value).toBe("ab");
			expect(buf.cursorPos).toBe(2);
		});

		it.each(CLUSTERS)("delete-forward removes a whole %s", (_name, cluster) => {
			const buf = new TextBuffer();
			buf.insert(`${cluster}ab`);
			buf.moveLineStart();

			buf.deleteForward();

			expect(buf.value).toBe("ab");
		});

		it.each(CLUSTERS)("arrows step over a whole %s", (_name, cluster) => {
			const buf = new TextBuffer();
			buf.insert(`a${cluster}b`);
			buf.moveLineStart();

			buf.moveRight();
			expect(buf.cursorPos).toBe(1);
			buf.moveRight();
			expect(buf.cursorPos).toBe(1 + cluster.length);
			buf.moveLeft();
			expect(buf.cursorPos).toBe(1);
		});

		it("keeps a long draft responsive", () => {
			// The boundary lookup is windowed because segmenting the whole buffer
			// costs 49ms at 100KB — on every keystroke.
			const buf = new TextBuffer();
			buf.insert("hello \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} e\u0301 日本語 ".repeat(4200));
			const startedAt = performance.now();
			for (let i = 0; i < 200; i++) buf.backspace();
			expect(performance.now() - startedAt).toBeLessThan(2000);
		});
	});

	describe("graphemeAt", () => {
		it("returns the whole cluster the cursor cell must render", () => {
			const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
			expect(graphemeAt(`ab${family}c`, 2)).toBe(family);
			expect(graphemeAt("e\u0301x", 0)).toBe("e\u0301");
			expect(graphemeAt("abc", 1)).toBe("b");
			expect(graphemeAt("abc", 3)).toBe("");
			expect(graphemeAt("", 0)).toBe("");
		});
	});

	it("inserts text at the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		expect(buf.value).toBe("hello");
		expect(buf.cursorPos).toBe(5);
	});

	it("inserts in the middle", () => {
		const buf = new TextBuffer();
		buf.insert("helo");
		buf.moveLeft();
		buf.moveLeft();
		buf.insert("l");
		expect(buf.value).toBe("hello");
		expect(buf.cursorPos).toBe(3);
	});

	it("backspace deletes before the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.backspace();
		expect(buf.value).toBe("hell");
		expect(buf.cursorPos).toBe(4);
	});

	it("backspace at position 0 is a no-op", () => {
		const buf = new TextBuffer();
		buf.backspace();
		expect(buf.value).toBe("");
		expect(buf.cursorPos).toBe(0);
	});

	it("deleteForward deletes after the cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.moveLeft();
		buf.moveLeft();
		buf.deleteForward();
		expect(buf.value).toBe("helo");
		expect(buf.cursorPos).toBe(3);
	});

	it("insertNewline and cursor movement across lines", () => {
		const buf = new TextBuffer();
		buf.insert("ab");
		buf.insertNewline();
		buf.insert("cd");
		expect(buf.value).toBe("ab\ncd");
		expect(buf.getCursorLine()).toBe(1);
		expect(buf.getCursorColumn()).toBe(2);
		buf.moveLineStart();
		expect(buf.getCursorColumn()).toBe(0);
		buf.moveLineEnd();
		expect(buf.getCursorColumn()).toBe(2);
	});

	it("clear resets text and cursor", () => {
		const buf = new TextBuffer();
		buf.insert("hello");
		buf.clear();
		expect(buf.value).toBe("");
		expect(buf.cursorPos).toBe(0);
		expect(buf.length).toBe(0);
	});

	it("bracketed paste payload inserts verbatim with newlines", () => {
		const buf = new TextBuffer();
		buf.insert("line1\nline2\nline3");
		expect(buf.getLines()).toEqual(["line1", "line2", "line3"]);
	});

	describe("surrogate pairs (emoji)", () => {
		it("backspace removes a whole astral character, not half a pair", () => {
			const buf = new TextBuffer();
			buf.insert("a😀"); // 😀 = U+1F600, two UTF-16 units
			buf.backspace();
			expect(buf.value).toBe("a");
			expect(buf.cursorPos).toBe(1);
		});

		it("deleteForward removes a whole astral character", () => {
			const buf = new TextBuffer();
			buf.insert("😀b");
			buf.moveLineStart();
			buf.deleteForward();
			expect(buf.value).toBe("b");
			expect(buf.cursorPos).toBe(0);
		});

		it("moveLeft/moveRight step over a pair as one character", () => {
			const buf = new TextBuffer();
			buf.insert("a😀b");
			buf.moveLeft(); // before b
			expect(buf.cursorPos).toBe(3);
			buf.moveLeft(); // before 😀 (skips both units)
			expect(buf.cursorPos).toBe(1);
			buf.moveRight(); // after 😀
			expect(buf.cursorPos).toBe(3);
		});
	});
});

describe("multi-line drafts", () => {
	// ↑/↓ move inside a draft that has line breaks in it (Shift+Enter, or a
	// trailing backslash before Enter); the false return is what tells the
	// Composer to recall a prompt from history instead.
	it("moves between lines and reports when there is none", () => {
		const b = new TextBuffer();
		b.insert("first");
		b.insertNewline();
		b.insert("second line");
		expect(b.moveDown()).toBe(false);
		expect(b.moveUp()).toBe(true);
		// Column is kept where it fits: 11 on line two, clamped to 5 on line one.
		expect(b.cursorPos).toBe("first".length);
		expect(b.moveUp()).toBe(false);
		expect(b.moveDown()).toBe(true);
		expect(b.cursorPos).toBe("first\n".length + 5);
	});

	it("never lands inside a surrogate pair when moving by line", () => {
		const b = new TextBuffer();
		b.insert("👨‍👩‍👧‍👦x");
		b.insertNewline();
		b.insert("abcdefghij");
		expect(b.moveUp()).toBe(true);
		// The line above is shorter in cells but longer in UTF-16 units; the
		// cursor must still sit on a cluster boundary.
		expect(b.cursorPos).toBeLessThanOrEqual("👨‍👩‍👧‍👦x".length);
		expect(b.value.charCodeAt(b.cursorPos) & 0xfc00).not.toBe(0xdc00);
	});

	it("replaceRange rewrites a slice and leaves the cursor after it", () => {
		const b = new TextBuffer();
		b.setText("посмотри src/ui/Comp");
		b.moveLineEnd();
		b.replaceRange(16, 20, "Composer.tsx");
		expect(b.value).toBe("посмотри src/ui/Composer.tsx");
		expect(b.cursorPos).toBe(b.value.length);
	});
});
