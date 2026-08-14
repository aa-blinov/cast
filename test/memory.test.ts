import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	buildMemoryPrompt,
	buildMemorySearchQuery,
	createProjectMemoryService,
	formatMemoryToolResult,
	formatMemoryTranscript,
	listProjectMemory,
	type MemoryEntry,
	parseMemoryWriterOutput,
	projectIdForCwd,
	scheduleProjectMemoryExtraction,
	searchProjectMemory,
	storeProjectMemory,
} from "../src/core/memory.ts";
import { createSession, getSessionEvents, saveSession } from "../src/core/session.ts";

describe("project memory", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-memory-test-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps project memory isolated by cwd and searchable across sessions", () => {
		const projectCwd = join(root, "project-a");
		const otherCwd = join(root, "project-b");
		const entry: MemoryEntry = {
			content: "The daemon uses a single-writer bridge and SSE reconnects with the same client message id.",
			type: "architecture",
			importance: 90,
		};

		storeProjectMemory(projectCwd, "session-a", "turn-a", [entry]);
		expect(listProjectMemory(projectCwd)).toEqual([
			expect.objectContaining({
				content: entry.content,
				sourceSessionId: "session-a",
			}),
		]);

		expect(searchProjectMemory(projectCwd, "single writer SSE")).toEqual([
			expect.objectContaining({
				content: entry.content,
				type: "architecture",
				projectId: projectIdForCwd(projectCwd),
			}),
		]);
		expect(searchProjectMemory(otherCwd, "single writer SSE")).toEqual([]);

		storeProjectMemory(projectCwd, "session-a", "turn-a", [entry]);
		expect(searchProjectMemory(projectCwd, "single writer")).toHaveLength(1);
	});

	it("renders only relevant memory into the next session prompt", () => {
		const projectCwd = join(root, "project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{
				content: "MiniMax M3 needs the native reasoning_content field preserved on tool-call turns.",
				type: "provider",
				importance: 95,
			},
			{ content: "The project uses Vitest for isolated integration tests.", type: "testing", importance: 70 },
		]);

		const prompt = buildMemoryPrompt(projectCwd, "How should native reasoning be sent?");
		expect(prompt).toContain("<project-memory>");
		expect(prompt).toContain("native reasoning_content");
		expect(prompt).not.toContain("Vitest for isolated");
	});

	it("records retrieval and writes as durable session events", () => {
		const projectCwd = join(root, "project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		storeProjectMemory(projectCwd, session.id, "turn-a", [
			{ content: "The daemon owns one writer per session.", type: "architecture", importance: 80 },
		]);

		const service = createProjectMemoryService();
		service.buildPrompt(projectCwd, "daemon writer", session.id);

		const eventTypes = getSessionEvents(session.id).map((event) => event.type);
		expect(eventTypes).toContain("memory_updated");
		expect(eventTypes).toContain("memory_context_retrieved");
	});

	it("serializes concurrent writes without duplicate memory rows", async () => {
		const projectCwd = join(root, "project");
		const entry: MemoryEntry = { content: "A single durable fact is fingerprinted once.", type: "rule" };
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				Promise.resolve().then(() => storeProjectMemory(projectCwd, `session-${index}`, "turn-a", [entry])),
			),
		);
		expect(searchProjectMemory(projectCwd, "durable fact fingerprinted")).toHaveLength(1);
	});

	it("builds safe OR search queries and formats a tool result", () => {
		expect(buildMemorySearchQuery("SSE reconnect: client-id")).toBe('"SSE" OR "reconnect" OR "client" OR "id"');
		expect(buildMemorySearchQuery("---")).toBe("");
		expect(formatMemoryToolResult("connection", [])).toContain("No project memory matched");
	});

	it("parses the writer contract and scopes extraction to the latest turn", () => {
		const transcript = formatMemoryTranscript([
			{ role: "user", content: "old request" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "new request" },
			{ role: "assistant", content: "new answer" },
		]);
		expect(transcript).toBe("user: new request\nassistant: new answer");
		expect(
			parseMemoryWriterOutput(
				'```json\n{"entries":[{"type":"rule","content":"Use isolated SQLite per test.","importance":88},{"type":"rule","content":"Use isolated SQLite per test.","importance":88}]}\n```',
			),
		).toEqual([{ type: "rule", content: "Use isolated SQLite per test.", importance: 88 }]);
	});

	it("queues background extraction per session instead of racing writers", async () => {
		const events: string[] = [];
		const service = {
			search: () => [],
			buildPrompt: () => "",
			extractAndStoreProjectMemory: async (input: { messages: Array<{ content?: unknown }> }) => {
				const label = String(input.messages[0]?.content);
				events.push(`start:${label}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				events.push(`end:${label}`);
				return { entries: [], transcript: label };
			},
		};
		const input = (label: string) => ({
			cwd: join(root, "project"),
			sessionId: "session-a",
			model: "test-model",
			config: {} as AppConfig,
			messages: [{ role: "user" as const, content: label }],
		});

		await Promise.all([
			scheduleProjectMemoryExtraction(input("first"), service),
			scheduleProjectMemoryExtraction(input("second"), service),
		]);

		expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
	});
});
