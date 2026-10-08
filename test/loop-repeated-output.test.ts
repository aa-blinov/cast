import { describe, expect, it } from "vitest";
import { noteRepeatedOutputs } from "../src/core/loop.ts";

const call = (content: string, name = "bash") => ({ id: "c", name, result: { content, isError: true } });

describe("noteRepeatedOutputs", () => {
	it("tells the model on the 4th identical output, numbers masked, then again on the 8th", () => {
		const seen = new Map<string, number>();
		const notes: boolean[] = [];
		for (let i = 0; i < 8; i++) {
			const batch = [call(`/usr/bin/python3: No module named pytest\nexit=${i}`)];
			noteRepeatedOutputs(batch, seen);
			notes.push(batch[0]!.result.content.includes("<system-reminder>This is the"));
		}
		expect(notes).toEqual([false, false, false, true, false, false, false, true]);
	});

	it("counts per tool and per output, so different results never add up", () => {
		const seen = new Map<string, number>();
		const batch = [call("same"), call("same", "read"), call("other"), call("same")];
		noteRepeatedOutputs(batch, seen);
		noteRepeatedOutputs([call("same")], seen);
		const fourth = [call("same")];
		noteRepeatedOutputs(fourth, seen);
		expect(fourth[0]!.result.content).toContain("4th time bash");
		expect(seen.get("read\0same")).toBe(1);
	});

	it("asks the caller to stop at the 25th repeat, but never for a polled job", () => {
		const seen = new Map<string, number>();
		const results: boolean[] = [];
		for (let i = 0; i < 25; i++) results.push(noteRepeatedOutputs([call("No files found", "glob")], seen));
		expect(results.indexOf(true)).toBe(24);
		const polled = new Map<string, number>();
		for (let i = 0; i < 150; i++)
			expect(noteRepeatedOutputs([call("still running", "bash_output")], polled)).toBe(false);
	});
});
