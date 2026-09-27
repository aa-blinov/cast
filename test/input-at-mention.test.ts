import { describe, expect, it } from "vitest";
import { atTokenAt } from "../src/ui/input/at-mention.ts";

describe("atTokenAt", () => {
	it("finds the @token the cursor is in", () => {
		expect(atTokenAt("@", 1)).toEqual({ from: 0, query: "" });
		expect(atTokenAt("look at @src/comp", 17)).toEqual({ from: 8, query: "src/comp" });
		// Only up to the cursor: the rest of the word is replaced on accept.
		expect(atTokenAt("see @Compo and", 8)).toEqual({ from: 4, query: "Com" });
		expect(atTokenAt("line one\n@x", 11)).toEqual({ from: 9, query: "x" });
	});

	it("stays closed outside one: plain words, e-mail addresses, after a space", () => {
		expect(atTokenAt("hello", 5)).toBeUndefined();
		expect(atTokenAt("mail a@b.com", 12)).toBeUndefined();
		expect(atTokenAt("@done ", 6)).toBeUndefined();
	});
});
