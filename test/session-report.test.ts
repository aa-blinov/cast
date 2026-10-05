import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { createSession } from "../src/core/session.ts";
import { exportFileName, exportMarkdown, formatCost, saveExport, sessionCostText } from "../src/core/session-report.ts";
import { querySessionCost, recordLlmRequest } from "../src/core/telemetry.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-report-test-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

const session = () => {
	const s = createSession("m-1", root);
	s.title = "Fix the parser!";
	s.messages.push(
		{ role: "system", content: "SECRET SYSTEM PROMPT" },
		{ role: "user", content: "fix it" },
		{
			role: "assistant",
			content: "Looking.",
			tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", content: "a.ts\n```\nb.ts" },
		{ role: "assistant", content: "Done." },
	);
	return s;
};

describe("formatCost", () => {
	it("says tokens, cache share, subagent share, and a price only when the provider reported one", () => {
		const s = session();
		s.usage = {
			promptTokens: 1000,
			completionTokens: 200,
			totalTokens: 1200,
			cost: 0.0123,
			cacheReadTokens: 750,
			cacheWriteTokens: 0,
			uncachedTokens: 250,
			subagentTokens: 300,
		};
		const text = formatCost(s, []);
		expect(text).toContain("Tokens: 1,200 (1,000 in, 200 out)");
		expect(text).toContain("75% of input read from cache");
		expect(text).toContain("Subagents: 300 tokens");
		expect(text).toContain("Cost: $0.0123");
		expect(text).not.toContain("By kind");
		s.usage.cost = 0;
		expect(formatCost(s, [])).toContain("not reported by the provider");
	});

	it("lists what telemetry recorded per kind of request, including work the chat does not show", () => {
		const s = session();
		recordLlmRequest({ sessionId: s.id, kind: "main", promptTokens: 100, completionTokens: 10, cost: 0.5 });
		recordLlmRequest({ sessionId: s.id, kind: "main", promptTokens: 100, completionTokens: 10, cost: 0.25 });
		recordLlmRequest({ sessionId: s.id, kind: "side", promptTokens: 40, completionTokens: 4 });
		recordLlmRequest({ sessionId: "other", kind: "main", promptTokens: 9_999 });
		const rows = querySessionCost(s.id);
		expect(rows.map((r) => [r.kind, r.requests, r.promptTokens, r.cost])).toEqual([
			["main", 2, 200, 0.75],
			["side", 1, 40, null],
		]);
		const text = sessionCostText(s);
		expect(text).toContain("main: 2 requests, 200 in, 20 out, $0.7500");
		expect(text.endsWith("side: 1 request, 40 in, 4 out")).toBe(true);
	});
});

describe("exportMarkdown", () => {
	it("is the conversation with tool calls and results, without the system prompt, and fences that output cannot close", () => {
		const md = exportMarkdown(session());
		expect(md.startsWith("# Fix the parser!\n")).toBe(true);
		expect(md).not.toContain("SECRET SYSTEM PROMPT");
		expect(md).toContain("## User\n\nfix it");
		expect(md).toContain("Tool call `bash`:");
		expect(md).toContain("Result of `bash`:");
		// The result holds a triple backtick, so its fence is longer.
		expect(md).toContain("````\na.ts\n```\nb.ts\n````");
		expect(md.trimEnd().endsWith("Done.")).toBe(true);
	});

	it("cuts a long tool result and says how much", () => {
		const s = createSession("m", root);
		s.messages.push(
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c", content: "x".repeat(5_000) },
		);
		expect(exportMarkdown(s)).toContain("… (3,000 more characters)");
	});
});

describe("saveExport", () => {
	it("writes a private file under ~/.cast/exports named from the title", () => {
		vi.stubEnv("HOME", root);
		const s = session();
		expect(exportFileName(s)).toBe(`fix-the-parser-${s.id.slice(0, 8)}.md`);
		const path = saveExport(s);
		expect(path).toBe(join(root, ".cast", "exports", exportFileName(s)));
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toContain("## Assistant");
		expect(statSync(path).mode & 0o077).toBe(0);
		vi.unstubAllEnvs();
	});
});
