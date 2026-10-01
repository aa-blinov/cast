import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../src/ui/markdown-terminal.ts";
import type { ToolCallEntry } from "../src/ui/useAgentSession.ts";
import { blockLines, messageLines, sectionLines, toolRowLines } from "../src/ui-pi/lines.ts";

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
		expect(plain(toolRowLines(bash("error", "false"), 60)[0]!)).toMatch(/^ {2}✗ bash false.* failed$/);
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
		expect(plain(toolRowLines(task("queued"), 100)[0]!)).toContain("[explore queued * 2]");
		expect(plain(toolRowLines(task("running", { name: "read", summary: "a.ts" }), 100)[0]!)).toContain(
			"[explore ↳ read a.ts * 2]",
		);
	});
});

describe("sectionLines", () => {
	it("sets the speaker as a bold heading under a blank row, and hangs what was said at the indent", () => {
		const lines = sectionLines(renderMarkdownLines("first\nsecond", { width: 40 }), { heading: "YOU" });
		expect(lines.map(plain)).toEqual(["", "YOU", "    first", "    second"]);
		expect(lines[1]).toContain("\x1b[1m");
	});

	it("sets code four columns further in, and carries no coloured edge", () => {
		const lines = blockLines(
			{ kind: "content" as const, text: "```ts\nconst x = 1;\n```" },
			{ width: 60, showReasoning: false },
		).map(plain);
		expect(lines.find((line) => line.includes("const x"))?.startsWith("        const")).toBe(true);
		for (const mark of ["▌", "┆", "│"]) expect(lines.join("")).not.toContain(mark);
	});

	it("wraps code that is too long for a phone screen, instead of cutting it off", () => {
		const code = "const greeting = (name: string): string => `hello, ${name} from the transcript`;";
		const rows = blockLines(
			{ kind: "content" as const, text: `\`\`\`ts\n${code}\n\`\`\`` },
			{ width: 32, showReasoning: false },
		);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(32);
		const rejoined = rows.map(plain).join("").replace(/\s+/g, "");
		expect(rejoined).toContain(code.replace(/\s+/g, ""));
	});

	it("puts no heading on a continued block, and a blank row on a notice", () => {
		expect(sectionLines(renderMarkdownLines("more", { width: 40 })).map(plain)).toEqual(["    more"]);
		expect(sectionLines(renderMarkdownLines("note", { width: 40 }), { gap: true, quiet: true }).map(plain)).toEqual([
			"",
			"    note",
		]);
	});
});

describe("messageLines and blockLines", () => {
	it("shows a notice indented, without its [system] prefix", () => {
		const rows = messageLines({ role: "warning", content: "[system] careful" }, { width: 80, showReasoning: false });
		expect(rows.map(plain)).toEqual(["", "    careful"]);
	});

	it("names the speaker YOU and AGENT", () => {
		const you = messageLines({ role: "user", content: "hi" }, { width: 80, showReasoning: false });
		expect(you.map(plain)).toEqual(["", "YOU", "    hi"]);
		const agent = blockLines({ kind: "content" as const, text: "ok" }, { width: 80, showReasoning: false });
		expect(agent.map(plain)).toEqual(["", "AGENT", "    ok"]);
	});

	it("hides reasoning unless asked, and never wraps past the width", () => {
		const thinking = { kind: "thinking" as const, text: "hmm ".repeat(60) };
		expect(blockLines(thinking, { width: 50, showReasoning: false })).toEqual([]);
		const shown = blockLines(thinking, { width: 50, showReasoning: true });
		expect(plain(shown[1]!)).toBe("REASONING");
		for (const row of shown) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
	});
});
