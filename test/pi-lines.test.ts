import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../src/ui/markdown-terminal.ts";
import type { ToolCallEntry } from "../src/ui/useAgentSession.ts";
import { blockLines, messageLines, railLines, toolRowLines } from "../src/ui-pi/lines.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const LONG = `cd /home/ubuntu/project && ${"grep -E 'pattern' src/**/*.ts | sort; ".repeat(8)}sleep 25`;
const bash = (status: ToolCallEntry["status"], command = LONG): ToolCallEntry => ({
	id: "t",
	name: "bash",
	args: JSON.stringify({ command, timeout: 180000 }),
	status,
});

describe("toolRowLines", () => {
	it("is one row while the tool runs, however long its command, and never wider than the screen", () => {
		const rows = toolRowLines(bash("running"), 60);
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(60);
	});

	it("wraps in full once it has finished, marks a failure, and keeps every row within the width", () => {
		const done = toolRowLines(bash("ok"), 60);
		expect(done.length).toBeGreaterThan(1);
		for (const row of done) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		expect(plain(toolRowLines(bash("error", "false"), 60)[0]!)).toMatch(/^✗ bash false/);
	});

	it("says what a queued subagent is waiting for, and what a running one is doing", () => {
		const task = (status: "queued" | "running", tool?: { name: string; summary: string }): ToolCallEntry => ({
			id: "k",
			name: "task",
			args: JSON.stringify({ assignment: "look around", subagent: "explore" }),
			status: "running",
			progress: {
				toolCallId: "k",
				taskId: "c",
				subagent: "explore",
				description: "look",
				background: false,
				status,
				tool,
				toolCount: 2,
			},
		});
		expect(plain(toolRowLines(task("queued"), 100)[0]!)).toContain("[explore queued · 2]");
		expect(plain(toolRowLines(task("running", { name: "read", summary: "a.ts" }), 100)[0]!)).toContain(
			"[explore ↳ read a.ts · 2]",
		);
	});
});

describe("railLines", () => {
	it("puts the speaker on a row of its own and a rail on every line under it", () => {
		const lines = railLines(renderMarkdownLines("first\nsecond", { width: 40 }), { gutter: "#00ff00", label: "you" });
		expect(plain(lines[0]!)).toBe("▌ you");
		expect(lines.slice(1).map(plain)).toEqual(["▌ first", "▌ second"]);
	});
});

describe("messageLines and blockLines", () => {
	it("shows a notice on the ⓘ rail without its [system] prefix", () => {
		const rows = messageLines({ role: "warning", content: "[system] careful" }, { width: 80, showReasoning: false });
		expect(plain(rows[0]!)).toBe("ⓘ careful");
	});

	it("hides reasoning unless asked, and never wraps past the width", () => {
		const thinking = { kind: "thinking" as const, text: "hmm ".repeat(60) };
		expect(blockLines(thinking, { width: 50, showReasoning: false })).toEqual([]);
		const shown = blockLines(thinking, { width: 50, showReasoning: true });
		expect(plain(shown[0]!)).toBe("┆ reasoning");
		for (const row of shown) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
	});
});
