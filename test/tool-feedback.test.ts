import { describe, expect, it } from "vitest";
import type { ToolCallResult } from "../src/core/tool-feedback.ts";
import { checkKeyFor, noteEarlierCheck, noteRepeatedFailures, noteRepeatedOutputs } from "../src/core/tool-feedback.ts";

function call(id: string, name: string, content: string, isError = false): ToolCallResult {
	return { id, name, result: { content, isError } };
}

describe("tool feedback", () => {
	it("warns on repeated output and stops a non-polling runaway", () => {
		const seen = new Map<string, number>();
		let warned: ToolCallResult | undefined;
		for (let count = 1; count <= 25; count++) {
			const result = call(String(count), "bash", "same output");
			const runaway = noteRepeatedOutputs([result], seen);
			if (count === 24) warned = result;
			expect(runaway).toBe(count >= 25);
		}
		expect(warned?.result.content).toContain("Repeating the check won't change it");
	});

	it("keeps background polling exempt from repeated-output stopping", () => {
		const seen = new Map<string, number>();
		for (let count = 1; count <= 25; count++) {
			expect(noteRepeatedOutputs([call(String(count), "bash_output", "still running")], seen)).toBe(false);
		}
	});

	it("nudges repeated tool failures and clears the count after success", () => {
		const seen = new Map<string, number>();
		noteRepeatedFailures([call("1", "mcp_lookup", "missing", true)], seen);
		noteRepeatedFailures([call("2", "mcp_lookup", "missing", true)], seen);
		const third = call("3", "mcp_lookup", "missing", true);
		noteRepeatedFailures([third], seen);
		expect(third.result.content).toContain("3rd time mcp_lookup has failed");

		noteRepeatedFailures([call("4", "mcp_lookup", "found")], seen);
		const next = call("5", "mcp_lookup", "missing", true);
		noteRepeatedFailures([next], seen);
		expect(next.result.content).toBe("missing");
	});

	it("normalizes checks and reminds only once when a failed check repeats", () => {
		expect(checkKeyFor("cd /repo && npm test 2>&1 | grep FAIL > out.txt")).toBe("npm test");
		const memory = new Map<string, { turn: number; shown?: boolean }>();
		const commands = new Map([
			["first", "npm test"],
			["second", "npm test | grep FAIL"],
		]);
		const first = call("first", "bash", "tests failed", true);
		const second = call("second", "bash", "tests failed again", true);

		noteEarlierCheck([first], memory, 3, commands, 3);
		noteEarlierCheck([second], memory, 7, commands, 3);
		expect(second.result.content).toContain("no edit or write since");
		expect(memory.get("npm test")?.shown).toBe(true);
	});
});
