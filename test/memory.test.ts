import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { streamAndCollect } from "../src/core/llm.ts";
import {
	buildMemoryPrompt,
	buildMemorySearchQuery,
	createProjectMemoryService,
	distillProjectMemory,
	drainProjectCheckpointWriters,
	dreamProjectMemory,
	extractAndStoreProjectMemory,
	formatMemoryHistory,
	formatMemoryToolResult,
	formatMemoryTranscript,
	getProjectCheckpointWriterSnapshot,
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
	waitForProjectCheckpointWriter,
	withProjectMemoryLease,
} from "../src/core/memory.ts";
import {
	checkpointPath,
	ensureMemoryFiles,
	projectMemoryManifestPath,
	projectMemoryPath,
	readMemoryFile,
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

	it("keeps FTS5 rank ordering equivalent to direct BM25", () => {
		const projectCwd = join(root, "rank-project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{ content: "The daemon uses a single writer for the SSE bridge.", type: "architecture", importance: 90 },
			{ content: "The daemon reconnects the SSE client after a timeout.", type: "reliability", importance: 80 },
			{ content: "The daemon keeps the bridge state in SQLite.", type: "storage", importance: 70 },
		]);
		const projectId = projectIdForCwd(projectCwd);
		const db = getDb();
		const query = '"daemon" OR "SSE"';
		const params = [query, projectId] as const;
		const bm25Rows = db
			.prepare(`
				SELECT m.id, -bm25(project_memory_fts) AS score
				FROM project_memory_fts
				JOIN project_memory AS m ON m.id = project_memory_fts.rowid
				WHERE project_memory_fts MATCH ? AND m.project_id = ?
				ORDER BY score DESC, m.importance DESC, m.updated_at DESC
			`)
			.all(...params) as Array<{ id: number; score: number }>;
		const rankRows = db
			.prepare(`
				SELECT m.id, -project_memory_fts.rank AS score
				FROM project_memory_fts
				JOIN project_memory AS m ON m.id = project_memory_fts.rowid
				WHERE project_memory_fts MATCH ? AND m.project_id = ?
				ORDER BY project_memory_fts.rank ASC, m.importance DESC, m.updated_at DESC
			`)
			.all(...params) as Array<{ id: number; score: number }>;

		expect(rankRows.map((row) => row.id)).toEqual(bm25Rows.map((row) => row.id));
		expect(rankRows.map((row) => row.score)).toEqual(bm25Rows.map((row) => row.score));
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

	it("fits retrieved memory to a token budget and prefers higher-importance facts", () => {
		const projectCwd = join(root, "budgeted-project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{
				content:
					"prefix cache architecture fact: the provider must keep the system instructions byte stable across turns.",
				type: "architecture",
				importance: 95,
			},
			{
				content: "prefix cache incidental fact: a one-off diagnostic request once used a temporary model name.",
				type: "general",
				importance: 10,
			},
		]);

		const prompt = buildMemoryPrompt(projectCwd, "prefix cache", undefined, { tokenBudget: 100 });

		expect(prompt).toContain("provider must keep the system instructions byte stable");
		expect(prompt).not.toContain("one-off diagnostic request");
	});

	it("reconstructs the durable project index when no retrieval query is available", () => {
		const projectCwd = join(root, "reconstruction-project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{ content: "The bridge owns one writer per session.", type: "architecture", importance: 90 },
		]);

		const prompt = buildMemoryPrompt(projectCwd, "", undefined, { tokenBudget: 120 });

		expect(prompt).toContain("The bridge owns one writer per session.");
	});

	it("does not retrieve expired memory and keeps confidence metadata", () => {
		const projectCwd = join(root, "expiry-project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{
				content: "This decision is still active.",
				type: "decision",
				importance: 91,
				confidence: 88,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			},
			{
				content: "This temporary decision has expired.",
				type: "decision",
				importance: 99,
				confidence: 40,
				expiresAt: new Date(Date.now() - 60_000).toISOString(),
			},
		]);

		expect(listProjectMemory(projectCwd)).toEqual([
			expect.objectContaining({ content: "This decision is still active.", confidence: 88 }),
		]);
	});

	it("serializes memory operations through a durable SQLite lease", async () => {
		const projectCwd = join(root, "lease-project");
		const events: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});

		const first = withProjectMemoryLease(projectCwd, "test", async () => {
			events.push("first:start");
			await blocked;
			events.push("first:end");
		});
		await new Promise((resolve) => setImmediate(resolve));
		const second = withProjectMemoryLease(projectCwd, "test", async () => {
			events.push("second");
		});

		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual(["first:start"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("lets a new extraction explicitly supersede a contradictory fact", async () => {
		const projectCwd = join(root, "supersession-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		storeProjectMemory(projectCwd, session.id, "old-turn", [
			{ content: "The daemon uses port 1337.", type: "architecture", importance: 80 },
		]);
		const oldId = listProjectMemory(projectCwd)[0]!.id;
		vi.mocked(streamAndCollect).mockResolvedValueOnce({
			content: JSON.stringify({
				entries: [
					{
						type: "architecture",
						content: "The daemon uses port 1444.",
						importance: 90,
						confidence: 95,
						supersedes: [oldId],
					},
				],
			}),
		});

		await extractAndStoreProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [
				{ role: "user", content: "The port changed." },
				{ role: "assistant", content: "The daemon now uses port 1444." },
			],
		});

		expect(listProjectMemory(projectCwd)).toEqual([
			expect.objectContaining({ content: "The daemon uses port 1444.", confidence: 95 }),
		]);
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
		expect(JSON.parse(readMemoryFile(projectMemoryManifestPath(projectIdForCwd(projectCwd))))).toEqual(
			expect.objectContaining({ version: 1, revision: 1, projectId: projectIdForCwd(projectCwd) }),
		);
	});

	it("retries an empty extraction when a completed turn contains enough durable context", async () => {
		const projectCwd = join(root, "retry-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		vi.mocked(streamAndCollect).mockClear();
		vi.mocked(streamAndCollect)
			.mockResolvedValueOnce({ content: JSON.stringify({ entries: [] }) })
			.mockResolvedValueOnce({
				content: JSON.stringify({
					entries: [{ type: "architecture", content: "The durable writer uses a SQLite lease.", importance: 90 }],
				}),
			});

		const result = await extractAndStoreProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [
				{
					role: "user",
					content:
						"We need to preserve this architecture decision across future sessions: every durable memory write must use the SQLite lease and the file manifest so another process cannot overwrite an active writer.",
				},
				{
					role: "assistant",
					content: "Implemented the lease and manifest and verified them with concurrent processes.",
				},
			],
		});

		expect(streamAndCollect).toHaveBeenCalledTimes(2);
		expect(result.entries).toEqual([expect.objectContaining({ content: "The durable writer uses a SQLite lease." })]);
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

	it("serializes checkpoint writes with background extraction for one project", async () => {
		const events: string[] = [];
		let releaseExtraction!: () => void;
		const extractionBlocked = new Promise<void>((resolve) => {
			releaseExtraction = resolve;
		});
		const service = {
			search: () => [],
			buildPrompt: () => "",
			extractAndStoreProjectMemory: async () => {
				events.push("extraction:start");
				await extractionBlocked;
				events.push("extraction:end");
				return { entries: [], transcript: "" };
			},
		};
		const projectCwd = join(root, "shared-writer-project");
		const input = {
			cwd: projectCwd,
			sessionId: "session-shared-writer",
			model: "test-model",
			config: {} as AppConfig,
			messages: [{ role: "user" as const, content: "checkpoint" }],
		};

		const extraction = scheduleProjectMemoryExtraction(input, service);
		await new Promise((resolve) => setImmediate(resolve));
		const writer = scheduleProjectCheckpointWriter(input, async () => {
			events.push("checkpoint");
		});

		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual(["extraction:start"]);
		releaseExtraction();
		await extraction;
		await writer.wait();

		expect(events).toEqual(["extraction:start", "extraction:end", "checkpoint"]);
	});

	it("uses isolated project memory files and reconciles them into the FTS index", () => {
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

	it("runs dream through a maintenance agent and reconciles its file edits", async () => {
		vi.mocked(streamAndCollect).mockClear();
		const projectCwd = join(root, "dream-agent-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const projectId = projectIdForCwd(projectCwd);
		const runAgent = async (input: { prompt: string; systemPrompt: string }) => {
			expect(input.systemPrompt).toContain("maintenance agent");
			expect(input.prompt).toContain("PROJECT_MEMORY_PATH");
			writeMemoryFile(
				projectMemoryPath(projectId),
				"# Project memory\n\n## Rules\n- Dream edits are authoritative.\n",
			);
			return { messages: [{ role: "assistant" as const, content: "Consolidated the project memory." }] };
		};

		const result = await dreamProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: "test-model",
			config: testConfig,
			messages: [{ role: "user", content: "consolidate memory" }],
			runAgent,
		});

		expect(result.stored).toBe(1);
		expect(searchProjectMemory(projectCwd, "Dream edits authoritative")).toEqual([
			expect.objectContaining({ content: "Dream edits are authoritative." }),
		]);
		expect(streamAndCollect).not.toHaveBeenCalled();
	});

	it("runs distill through a maintenance agent and indexes its project asset", async () => {
		vi.mocked(streamAndCollect).mockClear();
		const projectCwd = join(root, "distill-agent-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const runAgent = async (input: { prompt: string; systemPrompt: string }) => {
			expect(input.systemPrompt).toContain("workflow distillation agent");
			expect(input.prompt).toContain("PROJECT_ASSETS_ROOT");
			writeMemoryFile(
				join(projectCwd, ".cast", "skills", "release-check", "SKILL.md"),
				"---\nname: release-check\ndescription: Verify a release before publishing.\n---\n\nRun the release checks and inspect the result.",
			);
			return { messages: [{ role: "assistant" as const, content: "Created one skill." }] };
		};

		const result = await distillProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: "test-model",
			config: testConfig,
			messages: [{ role: "user", content: "distill the repeated release workflow" }],
			runAgent,
		});

		expect(result.artifacts).toEqual([
			expect.objectContaining({
				kind: "skill",
				name: "release-check",
				description: "Verify a release before publishing.",
			}),
		]);
		expect(streamAndCollect).not.toHaveBeenCalled();
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

	it("freezes pending checkpoint messages at enqueue time", async () => {
		const projectCwd = join(root, "writer-snapshot-project");
		const seen: string[] = [];
		let releaseFirst!: () => void;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const writer = async (input: { messages: Array<{ content?: unknown }> }): Promise<void> => {
			seen.push(String(input.messages[0]?.content));
			if (seen.length === 1) await firstDone;
		};

		const firstMessages = [{ role: "user" as const, content: "first" }];
		const secondMessages = [{ role: "user" as const, content: "second before mutation" }];
		scheduleProjectCheckpointWriter(
			{
				cwd: projectCwd,
				sessionId: "session-writer-snapshot",
				model: "test-model",
				config: testConfig,
				messages: firstMessages,
			},
			writer,
		);
		await new Promise((resolve) => setImmediate(resolve));
		scheduleProjectCheckpointWriter(
			{
				cwd: projectCwd,
				sessionId: "session-writer-snapshot",
				model: "test-model",
				config: testConfig,
				messages: secondMessages,
			},
			writer,
		);
		secondMessages[0]!.content = "second after mutation";
		releaseFirst();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(seen).toEqual(["first", "second before mutation"]);
	});

	it("exposes writer lifecycle and resolves superseded pending work", async () => {
		const projectCwd = join(root, "writer-lifecycle-project");
		let releaseFirst!: () => void;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const writer = async (input: { messages: Array<{ content?: unknown }> }): Promise<void> => {
			if (input.messages[0]?.content === "first") await firstDone;
		};
		const input = (label: string) => ({
			cwd: projectCwd,
			sessionId: "session-writer-lifecycle",
			model: "test-model",
			config: testConfig,
			messages: [{ role: "user" as const, content: label }],
		});

		const first = scheduleProjectCheckpointWriter(input("first"), writer);
		await new Promise((resolve) => setImmediate(resolve));
		const second = scheduleProjectCheckpointWriter(input("second"), writer);
		const third = scheduleProjectCheckpointWriter(input("third"), writer);

		expect(getProjectCheckpointWriterSnapshot(projectCwd, "session-writer-lifecycle")).toEqual({
			key: expect.stringContaining("session-writer-lifecycle"),
			running: true,
			activeId: first.id,
			pendingId: third.id,
		});
		expect(second.status()).toBe("superseded");
		expect(await second.wait()).toBe("superseded");

		releaseFirst();
		expect(await first.wait()).toBe("success");
		expect(await third.wait()).toBe("success");
		expect(await waitForProjectCheckpointWriter(projectCwd, "session-writer-lifecycle")).toBe("no-writer");
	});

	it("reports a bounded drain when a writer is still running", async () => {
		const projectCwd = join(root, "writer-drain-project");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handle = scheduleProjectCheckpointWriter(
			{
				cwd: projectCwd,
				sessionId: "session-writer-drain",
				model: "test-model",
				config: testConfig,
				messages: [{ role: "user", content: "blocked" }],
			},
			async () => blocked,
		);

		await new Promise((resolve) => setImmediate(resolve));
		expect(await drainProjectCheckpointWriters(1)).toEqual({ drained: 0, timedOut: 1 });
		expect(handle.status()).toBe("running");
		release();
		expect(await handle.wait()).toBe("success");
	});
});
