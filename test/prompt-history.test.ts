/**
 * ↑/↓ in the composer recall submitted prompts, the way every other terminal
 * input does. Before this they were wired to the text buffer's
 * cursorUp/cursorDown, and the buffer is one line by construction — so ↑ did
 * nothing and ↓ jumped the cursor to the end of the line.
 */
import { describe, expect, it } from "vitest";
import { PromptHistory } from "../src/ui/input/prompt-history.ts";

describe("PromptHistory", () => {
	it("walks back from the newest prompt and forward again", () => {
		const history = new PromptHistory(["first", "second", "third"]);

		expect(history.older("")).toBe("third");
		expect(history.older("")).toBe("second");
		expect(history.older("")).toBe("first");
		// Nothing older — the oldest entry stays on screen.
		expect(history.older("")).toBeNull();
		expect(history.newer()).toBe("second");
		expect(history.newer()).toBe("third");
	});

	it("restores the draft that was being typed", () => {
		const history = new PromptHistory(["earlier prompt"]);

		expect(history.older("half-written thought")).toBe("earlier prompt");
		expect(history.browsing).toBe(true);
		expect(history.newer()).toBe("half-written thought");
		expect(history.browsing).toBe(false);
	});

	it("does nothing on ↓ while editing the draft", () => {
		const history = new PromptHistory(["a"]);
		// null means "leave the composer alone" — not "clear it".
		expect(history.newer()).toBeNull();
	});

	it("has nothing to recall in a fresh session", () => {
		const history = new PromptHistory();
		expect(history.older("draft")).toBeNull();
		expect(history.size).toBe(0);
	});

	it("adds a submitted prompt and starts recall from it", () => {
		const history = new PromptHistory(["old"]);
		history.older("");

		history.push("just sent");

		expect(history.browsing).toBe(false);
		expect(history.older("")).toBe("just sent");
	});

	it("skips blanks and back-to-back repeats", () => {
		const history = new PromptHistory();
		history.push("same");
		history.push("same");
		history.push("   ");
		history.push("");

		expect(history.size).toBe(1);
	});

	it("keeps a bounded number of entries", () => {
		const history = new PromptHistory(Array.from({ length: 500 }, (_, i) => `p${i}`));
		expect(history.size).toBe(200);
		// The newest survive; the oldest are what gets dropped.
		expect(history.older("")).toBe("p499");
	});
});
