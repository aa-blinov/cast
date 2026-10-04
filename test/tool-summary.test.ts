import { describe, expect, it } from "vitest";
import { formatTimeout, parseToolSummary } from "../src/ui/tool-summary.ts";

describe("parseToolSummary: background tasks", () => {
	it("shows a bash_output wait the way a bash row shows its timeout, not as raw milliseconds", () => {
		expect(parseToolSummary("bash_output", '{"task_id":"bg-1","wait":30000}')).toEqual({
			kind: "generic",
			text: "bg-1 * wait 30s",
		});
		// What the tool will really wait is shown: a longer ask is capped, as it is for a bash timeout.
		expect(parseToolSummary("bash_output", '{"task_id":"bg-2","wait":90000}')).toMatchObject({
			text: "bg-2 * wait 1m",
		});
		// A value under the seconds threshold is seconds, as the tool reads it.
		expect(parseToolSummary("bash_output", '{"task_id":"bg-3","wait":20}')).toMatchObject({
			text: "bg-3 * wait 20s",
		});
	});

	it("names the task alone when there is no wait, and for bash_kill", () => {
		expect(parseToolSummary("bash_output", '{"task_id":"bg-1"}')).toEqual({ kind: "generic", text: "bg-1" });
		expect(parseToolSummary("bash_kill", '{"task_id":"bg-1"}')).toEqual({ kind: "generic", text: "bg-1" });
	});

	it("keeps a bash row's own timeout in the same units", () => {
		const row = parseToolSummary("bash", '{"command":"sleep 5","run_in_background":true,"timeout":60000}');
		expect(row).toMatchObject({ kind: "bash", timeoutMs: 60000 });
		expect(formatTimeout(60000)).toBe("1m");
	});
});
