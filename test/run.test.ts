import { describe, expect, it } from "vitest";
import { parseInteractiveAction } from "../src/core/run.ts";

describe("interactive run protocol", () => {
	it("accepts each supported action", () => {
		expect(parseInteractiveAction('{"type":"prompt","text":"inspect the project"}')).toEqual({
			type: "prompt",
			text: "inspect the project",
		});
		expect(parseInteractiveAction('{"type":"set_mode","mode":"plan"}')).toEqual({ type: "set_mode", mode: "plan" });
		expect(parseInteractiveAction('{"type":"answer_question","values":["a","b"]}')).toEqual({
			type: "answer_question",
			values: ["a", "b"],
		});
		expect(parseInteractiveAction('{"type":"plan_review","choice":"clean"}')).toEqual({
			type: "plan_review",
			choice: "clean",
		});
	});

	it("rejects malformed picker actions before touching a session", () => {
		expect(() => parseInteractiveAction('{"type":"prompt"}')).toThrow("prompt.text must be a string");
		expect(() => parseInteractiveAction('{"type":"answer_question","values":[1]}')).toThrow(
			"answer_question.values must be an array of strings",
		);
		expect(() => parseInteractiveAction('{"type":"plan_review","choice":"discard"}')).toThrow(
			"plan_review.choice must be continue, implement, or clean",
		);
	});
});
