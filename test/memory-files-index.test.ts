import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { execMemorySearch, projectIdForCwd } from "../src/core/memory.ts";
import { reconcileMemoryFileIndex, searchMemoryFiles } from "../src/core/memory-files-index.ts";
import { createSession, saveSession } from "../src/core/session.ts";
import { updateSettings } from "../src/core/settings.ts";

describe("memory file index", () => {
	let root = "";
	let memoryDir = "";
	let ccDir = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-memory-index-"));
		memoryDir = join(root, "memory");
		ccDir = join(root, "cc");
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		process.env.CAST_MEMORY_DIR = memoryDir;
		process.env.CAST_CC_MEMORY_DIR = ccDir;
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		delete process.env.CAST_MEMORY_DIR;
		delete process.env.CAST_CC_MEMORY_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	function writeMemoryFile(relativePath: string, content: string): void {
		const path = join(memoryDir, relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content, "utf8");
	}

	it("indexes the whole memory tree and searches checkpoint, notes, and task files", () => {
		const projectId = "aabbccdd";
		writeMemoryFile(
			`projects/${projectId}/MEMORY.md`,
			"# Project memory\n\n## Rules\n- Keep the daemon single-writer.\n",
		);
		writeMemoryFile(
			`projects/${projectId}/MEMORY-spillover.md`,
			"# Spillover\n- The retry budget is three attempts before the fallback path.\n",
		);
		writeMemoryFile(
			"sessions/sess-1/checkpoint.md",
			"# Session checkpoint\n\n## §1 Active intent\nWire the SSE reconnection timer to fire every 30 seconds.\n",
		);
		writeMemoryFile(
			"sessions/sess-1/notes.md",
			"# Session notes\n\n## [date]\nThe zebra migration must be rolled out in two phases.\n",
		);
		writeMemoryFile(
			"sessions/sess-1/tasks/T1/progress.md",
			"# Task progress\n- parser phase complete; validation phase pending\n",
		);
		writeMemoryFile("global/MEMORY.md", "# Global memory\n\n## Rules\n- Always quote shell arguments in prompts.\n");

		expect(reconcileMemoryFileIndex(false)).toEqual({ indexed: 6, pruned: 0 });

		const checkpointHits = searchMemoryFiles("reconnection timer", { scope: "sessions", scopeId: "sess-1" });
		expect(checkpointHits).toHaveLength(1);
		expect(checkpointHits[0]).toMatchObject({ scope: "sessions", scopeId: "sess-1", type: "checkpoint" });
		expect(checkpointHits[0]!.snippet).toContain("reconnection timer");

		const notesHits = searchMemoryFiles("zebra migration", { scope: "sessions", scopeId: "sess-1" });
		expect(notesHits).toHaveLength(1);
		expect(notesHits[0]).toMatchObject({ type: "notes" });

		const taskHits = searchMemoryFiles("validation phase", { scope: "sessions", scopeId: "sess-1" });
		expect(taskHits).toHaveLength(1);
		expect(taskHits[0]).toMatchObject({ type: "progress" });

		const spilloverHits = searchMemoryFiles("retry budget", { projectId });
		expect(spilloverHits.some((match) => match.path.includes("MEMORY-spillover"))).toBe(true);

		const globalHits = searchMemoryFiles("quote shell arguments", { scope: "global" });
		expect(globalHits).toHaveLength(1);
		expect(globalHits[0]).toMatchObject({ scope: "global" });
	});

	it("scopes session files by project through the tool merge", () => {
		const cwd = join(root, "workspace");
		const session = createSession("test-model", cwd);
		saveSession(session);
		const projectId = projectIdForCwd(cwd);
		writeMemoryFile(`projects/${projectId}/MEMORY.md`, "# Project memory\n\n## Rules\n- Keep the writer single.\n");
		writeMemoryFile(
			`sessions/${session.id}/notes.md`,
			"# Session notes\n\n## [date]\nThe daemon reconnects with a monotonic SSE sequence number.\n",
		);

		const toolResult = execMemorySearch({ query: "monotonic SSE sequence" }, cwd);
		expect(toolResult.content).toContain("monotonic SSE sequence");
		expect(toolResult.content).toContain(`sessions:${session.id}`);
		expect(toolResult.content).toContain("notes");

		const scoped = execMemorySearch(
			{ query: "monotonic SSE sequence", scope: "sessions", scope_id: session.id },
			cwd,
		);
		expect(scoped.content).toContain("monotonic SSE sequence");
	});

	it("indexes Claude Code memory under the cc scope with frontmatter types", () => {
		updateSettings({ memoryCcIndex: true });
		const slug = "slug-hello-world";
		mkdirSync(join(ccDir, slug, "memory"), { recursive: true });
		writeFileSync(
			join(ccDir, slug, "memory", "project-notes.md"),
			[
				"---",
				"metadata:",
				"  type: project",
				"---",
				"# Payment gateway",
				"The checkout webhook verifies requests with HMAC-SHA256 signatures.",
			].join("\n"),
			"utf8",
		);

		expect(reconcileMemoryFileIndex(true).indexed).toBe(1);
		const hits = searchMemoryFiles("HMAC-SHA256", { scope: "cc" });
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ scope: "cc", scopeId: slug, type: "project" });

		const scoped = searchMemoryFiles("HMAC-SHA256", { scope: "cc", scopeId: slug });
		expect(scoped).toHaveLength(1);

		// Disabling cc indexing prunes the rows so the scope stops matching.
		updateSettings({ memoryCcIndex: false });
		reconcileMemoryFileIndex(false);
		expect(searchMemoryFiles("HMAC-SHA256", { scope: "cc" })).toEqual([]);
	});

	it("exposes cc results through the memory tool", () => {
		updateSettings({ memoryCcIndex: true });
		mkdirSync(join(ccDir, "slug-a", "memory"), { recursive: true });
		writeFileSync(
			join(ccDir, "slug-a", "memory", "gotcha.md"),
			[
				"---",
				"metadata:",
				"  type: reference",
				"---",
				"# Gotcha",
				"The config cache is invalidated on file watch events.",
			].join("\n"),
			"utf8",
		);
		reconcileMemoryFileIndex(true);

		const result = execMemorySearch({ query: "config cache invalidated", scope: "cc" }, join(root, "workspace"));
		expect(result.content).toContain("config cache is invalidated");
		expect(result.content).toContain("reference");
	});

	it("reconciles prunes files that disappeared", () => {
		writeMemoryFile("sessions/sess-1/notes.md", "# Session notes\n\nThe unique debug token is cast-token-42.\n");
		reconcileMemoryFileIndex(false);
		expect(searchMemoryFiles("cast-token-42", { scope: "sessions", scopeId: "sess-1" })).toHaveLength(1);

		rmSync(join(memoryDir, "sessions"), { recursive: true, force: true });
		reconcileMemoryFileIndex(false);
		expect(searchMemoryFiles("cast-token-42", { scope: "sessions", scopeId: "sess-1" })).toEqual([]);
	});
});
