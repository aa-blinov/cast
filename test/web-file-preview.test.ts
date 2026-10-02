import { describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useEffect: () => {},
		useState: (value: unknown) => [value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { detectDelimiter, fileExtOf, parseDelimited, splitLines } from "../src/server/public/file-preview.js";

describe("web file preview helpers", () => {
	it("detects CSV and TSV delimiters", () => {
		expect(detectDelimiter("name;value\na;1", "csv")).toBe(";");
		expect(detectDelimiter("name\tvalue\na\t1", "tsv")).toBe("\t");
	});

	it("parses quoted delimiters and embedded newlines", () => {
		expect(parseDelimited('name,value\n"A, B","line 1\nline 2"', ",")).toEqual([
			["name", "value"],
			["A, B", "line 1\nline 2"],
		]);
	});

	it("handles dotfiles and nested paths when finding extensions", () => {
		expect(fileExtOf("src/app.ts")).toBe("ts");
		expect(fileExtOf(".env")).toBe("");
		expect(fileExtOf("Makefile")).toBe("");
	});
});

describe("splitLines", () => {
	it("does not count the empty line after a final newline", () => {
		expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
		expect(splitLines("a\nb")).toEqual(["a", "b"]);
		expect(splitLines("")).toEqual([""]);
		expect(splitLines("a\n\n")).toEqual(["a", ""]);
	});
});
