/**
 * `edit`'s matching layer (src/core/tools/text-replace.ts) had no tests at
 * all, despite being the code that decides which span of a user's file gets
 * overwritten. These cover the guarantees that matter when a match is fuzzy:
 * the replacement lands at the indentation of what it replaced, an ambiguous
 * or absent match fails instead of guessing, and a pathological line can't
 * take the process down.
 */
import { describe, expect, it } from "vitest";
import {
	convertToLineEnding,
	detectLineEnding,
	normalizeLineEndings,
	replace,
} from "../src/core/tools/text-replace.ts";

describe("replace — indentation", () => {
	it("re-indents a block matched without the file's indentation", () => {
		// The model routinely sends a block at the indentation it remembers,
		// not the file's. The indentation-flexible matcher finds it anyway, and
		// the replacement used to be written back verbatim: this dedented
		// `def go` out of the class, changing what the program means.
		const content = "class A:\n    def go(self):\n        first()\n        second()\n";
		const out = replace(
			content,
			"def go(self):\n    first()\n    second()",
			"def go(self):\n    first()\n    third()",
		);
		expect(out).toBe("class A:\n    def go(self):\n        first()\n        third()\n");
	});

	it("dedents a replacement written at a deeper indentation than the file's", () => {
		const content = "def go():\n    first()\n    second()\n";
		const out = replace(content, "        first()\n        second()", "        first()\n        third()");
		expect(out).toBe("def go():\n    first()\n    third()\n");
	});

	it("preserves tab indentation instead of converting it to spaces", () => {
		const content = "function go() {\n\tfirst();\n\tsecond();\n}\n";
		const out = replace(content, "first();\nsecond();", "first();\nthird();");
		expect(out).toBe("function go() {\n\tfirst();\n\tthird();\n}\n");
	});

	it("leaves an exact match untouched", () => {
		const content = "class A:\n    def go(self):\n        first()\n";
		const out = replace(content, "        first()", "        second()");
		expect(out).toBe("class A:\n    def go(self):\n        second()\n");
	});

	it("does not re-indent a replacement inside a single line", () => {
		const content = "    const x = compute(a, b);\n";
		const out = replace(content, "compute(a, b)", "compute(b, a)");
		expect(out).toBe("    const x = compute(b, a);\n");
	});
});

describe("replace — refusals", () => {
	it("refuses when oldString is not in the file", () => {
		expect(() => replace("a\nb\n", "nowhere", "x")).toThrow(/Could not find oldString/);
	});

	it("refuses an ambiguous match instead of picking one", () => {
		expect(() => replace("dup()\nother()\ndup()\n", "dup()", "changed()")).toThrow(/multiple matches/i);
	});

	it("replaces every occurrence when asked", () => {
		expect(replace("dup()\nother()\ndup()\n", "dup()", "changed()", true)).toBe("changed()\nother()\nchanged()\n");
	});

	it("refuses an identical replacement", () => {
		expect(() => replace("a\n", "a", "a")).toThrow(/identical/i);
	});

	it("refuses an empty oldString", () => {
		expect(() => replace("a\n", "", "b")).toThrow(/cannot be empty/i);
	});

	it("keeps a fuzzy match inside its own block instead of swallowing neighbours", () => {
		// A block matched by trimmed lines must replace exactly those lines —
		// not spill into the visually similar block right after it.
		const content = ["if (a) {", "  go();", "}", "if (b) {", "  go();", "}", ""].join("\n");
		const out = replace(content, "if (b) {\n  go();\n}", "if (b) {\n  stop();\n}");
		expect(out).toBe(["if (a) {", "  go();", "}", "if (b) {", "  stop();", "}", ""].join("\n"));
	});
});

describe("replace — pathological input", () => {
	it("compares two very long lines without allocating a full distance matrix", () => {
		// The block-anchor matcher scores the lines between its anchors with a
		// Levenshtein distance that allocated one matrix cell per character
		// pair — for the long single lines a minified bundle or generated data
		// file is made of, that is billions of cells. 50K characters each is
		// enough to OOM the worker without the cap and instant with it, so this
		// is a yes/no on the fix rather than a timing measurement.
		const longA = `const data = "${"ab".repeat(25_000)}";`;
		const longB = `const data = "${"ab".repeat(24_999)}cd";`;
		const content = ["function go() {", longA, "  tail();", "}", ""].join("\n");
		// Same anchors, a middle line that differs — this is what gets scored.
		const find = ["function go() {", longB, "  tail();", "}"].join("\n");
		let threw: unknown;
		try {
			replace(content, find, ["function go() {", "  replaced();", "  tail();", "}"].join("\n"));
		} catch (error) {
			// Whether it matches or is refused is not the point; not exhausting
			// memory is.
			threw = error;
		}
		expect(threw === undefined || threw instanceof Error).toBe(true);
	});
});

describe("line endings", () => {
	it("round-trips CRLF", () => {
		const crlf = "a\r\nb\r\n";
		expect(detectLineEnding(crlf)).toBe("\r\n");
		const normalized = normalizeLineEndings(crlf);
		expect(normalized).toBe("a\nb\n");
		expect(convertToLineEnding(normalized, "\r\n")).toBe(crlf);
	});

	it("leaves LF alone", () => {
		expect(detectLineEnding("a\nb\n")).toBe("\n");
		expect(convertToLineEnding("a\nb\n", "\n")).toBe("a\nb\n");
	});
});
