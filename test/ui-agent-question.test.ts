import { describe, expect, it } from "vitest";
import { parseQuestionToolResult } from "../src/ui/useAgentSession.ts";

describe("parseQuestionToolResult", () => {
	const validContent = JSON.stringify({
		question: true,
		questions: [
			{
				question: "Choose cache backend",
				options: [
					{ value: "memory", label: "In-memory" },
					{ value: "redis", label: "Redis" },
				],
				recommended: "redis",
			},
		],
		note: "The user will choose in the picker.",
	});

	it("extracts the question schema from the question tool result content", () => {
		expect(parseQuestionToolResult(validContent)).toEqual({
			questions: [
				{
					question: "Choose cache backend",
					options: [
						{ value: "memory", label: "In-memory" },
						{ value: "redis", label: "Redis" },
					],
					recommended: "redis",
				},
			],
		});
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseQuestionToolResult("not json")).toBeUndefined();
	});

	it("returns undefined when the payload carries no questions array", () => {
		expect(parseQuestionToolResult(JSON.stringify({ question: true }))).toBeUndefined();
	});

	it("returns undefined for an empty questions array", () => {
		expect(parseQuestionToolResult(JSON.stringify({ question: true, questions: [] }))).toBeUndefined();
	});
});
