import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { streamAndCollect } from "../src/core/llm.ts";
import {
	buildMemoryPrompt,
	buildMemorySearchQuery,
	createProjectMemoryService,
	distillProjectMemory,
	dreamProjectMemory,
	extractAndStoreProjectMemory,
	formatMemoryHistory,
	formatMemoryToolResult,
	formatMemoryTranscript,
	listProjectMemory,
	listProjectMemoryArtifacts,
	listProjectMemoryCheckpoints,
	type MemoryEntry,
	parseMemoryWriterOutput,
	parseMemoryWriterResult,
	projectIdForCwd,
	reconcileProjectMemoryFiles,
	scheduleProjectCheckpointWriter,
	scheduleProjectMemoryExtraction,
	searchProjectMemory,
	storeProjectMemory,
} from "../src/core/memory.ts";
import {
	checkpointPath,
	ensureMemoryFiles,
	projectMemoryPath,
	readProjectMemory,
	readSessionMemory,
	writeMemoryFile,
} from "../src/core/memory-files.ts";
import { createSession, getSessionEvents, saveSession } from "../src/core/session.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return {
		...actual,
		createClient: vi.fn(() => ({})),
		streamAndCollect: vi.fn(),
	};
});

const testConfig = {} as AppConfig;

describe("project memory", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-memory-test-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		process.env.CAST_MEMORY_DIR = join(root, "memory");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		delete process.env.CAST_MEMORY_DIR;
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
			formatMemoryHistory([
				{ role: "user", content: "old request" },
				{ role: "assistant", content: "old answer" },
				{ role: "user", content: "new request" },
				{ role: "assistant", content: "new answer" },
			]),
		).toBe("user: old request\nassistant: old answer\nuser: new request\nassistant: new answer");
		expect(
			parseMemoryWriterOutput(
				'```json\n{"entries":[{"type":"rule","content":"Use isolated SQLite per test.","importance":88},{"type":"rule","content":"Use isolated SQLite per test.","importance":88}]}\n```',
			),
		).toEqual([{ type: "rule", content: "Use isolated SQLite per test.", importance: 88 }]);
	});

	it("parses a structured checkpoint alongside durable entries", () => {
		const result = parseMemoryWriterResult(
			JSON.stringify({
				checkpoint: {
					activeIntent: "Finish the memory lifecycle",
					nextAction: "Add maintenance commands",
					directives: ["Keep memory optional"],
				},
				entries: [{ type: "architecture", content: "Checkpoint writes share the extraction transaction." }],
			}),
		);
		expect(result).toEqual({
			entries: [
				{ type: "architecture", content: "Checkpoint writes share the extraction transaction.", importance: 50 },
			],
			checkpoint: expect.objectContaining({
				activeIntent: "Finish the memory lifecycle",
				nextAction: "Add maintenance commands",
				directives: ["Keep memory optional"],
			}),
		});
	});

	it("stores the checkpoint in the same extraction cycle as durable memory", async () => {
		const projectCwd = join(root, "project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		vi.mocked(streamAndCollect).mockResolvedValueOnce({
			content: JSON.stringify({
				checkpoint: { activeIntent: "Ship memory", nextAction: "Run tests" },
				entries: [{ type: "rule", content: "Memory is globally switchable.", importance: 90 }],
			}),
		});

		const result = await extractAndStoreProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [
				{ role: "user", content: "Ship memory" },
				{ role: "assistant", content: "Run tests" },
			],
		});

		expect(result.checkpoint).toEqual(
			expect.objectContaining({ activeIntent: "Ship memory", nextAction: "Run tests" }),
		);
		expect(listProjectMemoryCheckpoints(projectCwd)).toHaveLength(1);
		expect(listProjectMemory(projectCwd)).toEqual([
			expect.objectContaining({ content: "Memory is globally switchable." }),
		]);
	});

	it("dreams over project memory and removes only rows belonging to the project", async () => {
		const projectCwd = join(root, "project");
		const otherCwd = join(root, "other");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		storeProjectMemory(projectCwd, session.id, "turn-a", [
			{ type: "stale", content: "The project used the removed daemon.", importance: 20 },
			{ type: "rule", content: "Keep the current daemon single-writer.", importance: 90 },
		]);
		storeProjectMemory(otherCwd, "other-session", "turn-a", [
			{ type: "rule", content: "Never delete this other project note.", importance: 90 },
		]);
		const staleId = listProjectMemory(projectCwd).find((item) => item.type === "stale")?.id;
		expect(staleId).toBeTypeOf("number");
		vi.mocked(streamAndCollect).mockResolvedValueOnce({
			content: JSON.stringify({
				removeIds: [staleId, listProjectMemory(otherCwd)[0]?.id],
				entries: [{ type: "decision", content: "The current daemon remains single-writer.", importance: 85 }],
			}),
		});

		const result = await dreamProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [{ role: "user", content: "Consolidate the project memory" }],
		});

		expect(result.removed).toBe(1);
		expect(listProjectMemory(projectCwd).some((item) => item.id === staleId)).toBe(false);
		expect(listProjectMemory(otherCwd)).toHaveLength(1);
		expect(getSessionEvents(session.id).map((event) => event.type)).toContain("memory_dream_completed");
	});

	it("distills a repeated workflow into a reusable project artifact", async () => {
		const projectCwd = join(root, "project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		vi.mocked(streamAndCollect).mockResolvedValueOnce({
			content: JSON.stringify({
				artifacts: [
					{
						kind: "skill",
						name: "isolated-tests",
						description: "Run tests against a temporary SQLite database.",
						content: "Create CAST_SESSIONS_DB in beforeEach and reset the connection after each test.",
					},
				],
			}),
		});

		const result = await distillProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [
				{ role: "user", content: "Make the tests isolated" },
				{ role: "assistant", content: "Use a temporary database and reset the connection." },
			],
		});

		expect(result.artifacts).toHaveLength(1);
		expect(listProjectMemoryArtifacts(projectCwd)).toEqual([
			expect.objectContaining({ name: "isolated-tests", kind: "skill" }),
		]);
		expect(getSessionEvents(session.id).map((event) => event.type)).toContain("memory_distill_completed");
	});

	it("serializes maintenance calls with the background writer queue", async () => {
		const projectCwd = join(root, "project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		let active = 0;
		let maxActive = 0;
		vi.mocked(streamAndCollect).mockImplementation(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return { content: JSON.stringify({ entries: [] }) };
		});

		await Promise.all([
			dreamProjectMemory({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [{ role: "user", content: "first maintenance" }],
			}),
			distillProjectMemory({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [{ role: "user", content: "second maintenance" }],
			}),
		]);

		expect(maxActive).toBe(1);
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

	it("uses isolated MiMo memory files and reconciles them into the FTS index", () => {
		const projectCwd = join(root, "project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const projectId = projectIdForCwd(projectCwd);
		ensureMemoryFiles(session.id, projectId);
		writeMemoryFile(
			projectMemoryPath(projectId),
			"# Project memory\n\n## Rules\n- Keep the daemon single-writer.\n\n## Architecture decisions\n- SSE reconnects reuse the client id.\n",
		);
		reconcileProjectMemoryFiles(projectCwd, session.id);

		expect(readProjectMemory(projectId)).toContain("Keep the daemon single-writer");
		expect(readSessionMemory(session.id).checkpoint).toContain("Session checkpoint");
		expect(searchProjectMemory(projectCwd, "single writer")).toEqual([
			expect.objectContaining({ type: "rule", content: "Keep the daemon single-writer." }),
		]);
		expect(checkpointPath(session.id)).toContain(join("memory", "sessions", session.id));
	});

	it("keeps one checkpoint writer active and lets the newest pending request win", async () => {
		const projectCwd = join(root, "writer-project");
		const seen: string[] = [];
		const writer = async (input: { messages: Array<{ content?: unknown }> }): Promise<void> => {
			seen.push(String(input.messages[0]?.content));
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		const input = (label: string) => ({
			cwd: projectCwd,
			sessionId: "session-writer",
			model: "test-model",
			config: testConfig,
			messages: [{ role: "user" as const, content: label }],
		});

		scheduleProjectCheckpointWriter(input("first"), writer);
		scheduleProjectCheckpointWriter(input("second"), writer);
		scheduleProjectCheckpointWriter(input("third"), writer);
		await new Promise((resolve) => setTimeout(resolve, 35));

		expect(seen).toEqual(["first", "third"]);
	});
});
