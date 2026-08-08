import { describe, expect, it } from "vitest";
import { collapseMidWordBoundaries, mergeMidWordBoundary } from "../src/server/public/reasoning-split.js";

describe("reasoning display boundaries", () => {
	it("moves only an explicit mid-word fragment from reasoning to content", () => {
		const result = mergeMidWordBoundary("The answer is clear.Сей", "час продолжу.");
		expect(result).toEqual({
			thinkingText: "The answer is clear.",
			contentText: "Сейчас продолжу.",
		});
	});

	it("keeps native reasoning blocks intact while collapsing an explicit boundary", () => {
		const blocks = [
			{ kind: "thinking", text: "План.Сей" },
			{ kind: "content", text: "час отвечу." },
		];
		expect(collapseMidWordBoundaries(blocks)).toEqual([
			{ kind: "thinking", text: "План." },
			{ kind: "content", text: "Сейчас отвечу." },
		]);
	});
});
