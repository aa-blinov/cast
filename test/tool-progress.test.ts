import { describe, expect, it } from "vitest";
import type { StreamingState } from "../src/server/public/stream-blocks.js";
import { applyToolProgress, formatToolProgress } from "../src/ui/tool-progress.ts";

describe("formatToolProgress", () => {
	it("shows steps of a total, a bare count, and a short one-line message", () => {
		expect(formatToolProgress({ progress: 3, total: 10, message: "reading" })).toBe("3/10 reading");
		expect(formatToolProgress({ progress: 0.5 })).toBe("0.5");
		expect(formatToolProgress({ progress: 1, total: 2, message: "a\n  b" })).toBe("1/2 a b");
		expect(formatToolProgress({ progress: 1, message: "x".repeat(60) })).toBe(`1 ${"x".repeat(37)}...`);
	});
});

describe("applyToolProgress", () => {
	const state: StreamingState = {
		blocks: [
			{ kind: "tool", call: { id: "a", name: "mcp_x_slow", args: "{}", status: "running" } },
			{ kind: "tool", call: { id: "b", name: "mcp_x_old", args: "{}", status: "ok" } },
		],
	};

	it("sets the text on the running call it names", () => {
		const next = applyToolProgress(state, { id: "a", progress: 2, total: 4 });
		expect(next.blocks[0]).toMatchObject({ call: { id: "a", toolProgress: "2/4" } });
		expect(next.blocks[1]).toBe(state.blocks[1]);
	});

	it("ignores an event for a finished or unknown call", () => {
		expect(applyToolProgress(state, { id: "b", progress: 1 })).toBe(state);
		expect(applyToolProgress(state, { id: "zzz", progress: 1 })).toBe(state);
	});
});
