import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { streamAndCollect } from "../src/core/llm.ts";
import {
	buildMemoryPrompt,
	buildMemorySearchQuery,
	cancelAutomaticMemoryRun,
	createProjectMemoryService,
	distillProjectMemory,
	drainProjectCheckpointWriters,
	dreamProjectMemory,
	formatMemoryToolResult,
	formatMemoryTranscript,
	getProjectCheckpointWriterSnapshot,
	listAutomaticMemoryRuns,
	listProjectMemory,
	listProjectMemoryArtifacts,
	type MemoryEntry,
	maybeRunAutomaticMemoryMaintenance,
	projectIdForCwd,
	readMemorySectionsWithinBudget,
	reconcileProjectMemoryFiles,
	scheduleProjectCheckpointWriter,
	searchProjectMemory,
	storeProjectMemory,
	waitForProjectCheckpointWriter,
	withProjectMemoryLease,
} from "../src/core/memory.ts";
import {
	checkpointPath,
	ensureMemoryFiles,
	globalMemoryPath,
	projectMemoryPath,
	readProjectMemory,
	readSessionMemory,
	writeMemoryFile,
} from "../src/core/memory-files.ts";
import {
	appendMessage,
	createSession,
	getFullHistory,
	getSessionEvents,
	loadSession,
	saveSession,
} from "../src/core/session.ts";
import { updateSettings } from "../src/core/settings.ts";

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

	it("supports Mimo-compatible project and session memory scopes", () => {
		const projectCwd = join(root, "scoped-memory-project");
		storeProjectMemory(projectCwd, "session-a", "turn-a", [
			{ content: "The project uses a single durable writer.", type: "architecture" },
		]);
		storeProjectMemory(projectCwd, "session-b", "turn-b", [
			{ content: "Session b resolved a retry bug.", type: "fix" },
		]);

		const projectResults = searchProjectMemory(projectCwd, "durable writer", 8, { scope: "projects" });
		expect(projectResults).toHaveLength(1);
		expect(projectResults[0]).toMatchObject({ scope: "projects", scopeId: projectIdForCwd(projectCwd) });

		const sessionResults = searchProjectMemory(projectCwd, "retry bug", 8, {
			scope: "sessions",
			scopeId: "session-b",
		});
		expect(sessionResults).toHaveLength(1);
		expect(sessionResults[0]).toMatchObject({ scope: "sessions", scopeId: "session-b", type: "fix" });
		expect(searchProjectMemory(projectCwd, "durable writer", 8, { scope: "sessions", scopeId: "session-b" })).toEqual(
			[],
		);
		expect(searchProjectMemory(projectCwd, "durable writer", 8, { scope: "global" })).toEqual([]);
		writeMemoryFile(globalMemoryPath(), "# Global memory\n\n## Rules\n- Always preserve user preferences.\n");
		const globalResults = searchProjectMemory(projectCwd, "user preferences", 8, { scope: "global" });
		expect(globalResults).toMatchObject([
			{ scope: "global", scopeId: "global", content: "Always preserve user preferences." },
		]);
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

	it("keeps rebuild file context section-aware under a token budget", () => {
		const content = [
			"# Project memory",
			"## Rules",
			"- rule one",
			"- rule two",
			"## Architecture decisions",
			"- decision one",
			"## Discovered durable knowledge",
			"- durable fact",
		].join("\n");
		const result = readMemorySectionsWithinBudget(content, 40);
		expect(result.text).toContain("## Rules");
		expect(result.text).toContain("## Architecture decisions");
		expect(result.text).toContain("## Discovered durable knowledge");
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
		expect(formatMemoryToolResult("connection", [])).toContain('No matches for "connection"');
		expect(formatMemoryToolResult("connection", [])).toContain("Escalate before giving up");
	});

	it("scopes the maintenance transcript to the latest turn", () => {
		expect(
			formatMemoryTranscript([
				{ role: "user", content: "old request" },
				{ role: "assistant", content: "old answer" },
				{ role: "user", content: "new request" },
				{ role: "assistant", content: "new answer" },
			]),
		).toBe("user: new request\nassistant: new answer");
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

	it("reconciles an externally edited project memory file before search", () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home");
		const projectCwd = join(root, "reconciled-project");
		const projectId = projectIdForCwd(projectCwd);
		writeMemoryFile(projectMemoryPath(projectId), "# Project memory\n\n## Rules\n- The first rule is obsolete.\n");
		reconcileProjectMemoryFiles(projectCwd);

		writeMemoryFile(
			projectMemoryPath(projectId),
			"# Project memory\n\n## Rules\n- The second rule is authoritative.\n",
		);
		expect(searchProjectMemory(projectCwd, "second rule")).toEqual([
			expect.objectContaining({ content: "The second rule is authoritative." }),
		]);

		writeMemoryFile(projectMemoryPath(projectId), "# Project memory\n");
		expect(searchProjectMemory(projectCwd, "second rule")).toEqual([]);
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
	});

	it("does not reconcile from an unreadable project memory path", () => {
		const projectCwd = join(root, "unreadable-project");
		const projectId = projectIdForCwd(projectCwd);
		writeMemoryFile(projectMemoryPath(projectId), "# Project memory\n\n## Rules\n- Keep the durable database row.\n");
		reconcileProjectMemoryFiles(projectCwd);
		rmSync(projectMemoryPath(projectId), { force: true });
		mkdirSync(projectMemoryPath(projectId), { recursive: true });

		expect(searchProjectMemory(projectCwd, "durable database row")).toEqual([
			expect.objectContaining({ content: "Keep the durable database row." }),
		]);
	});

	it("does not reconcile while another process owns the project memory lease", async () => {
		const projectCwd = join(root, "leased-project");
		const projectId = projectIdForCwd(projectCwd);
		writeMemoryFile(projectMemoryPath(projectId), "# Project memory\n\n## Rules\n- Keep the indexed rule.\n");
		reconcileProjectMemoryFiles(projectCwd);
		writeMemoryFile(projectMemoryPath(projectId), "# Project memory\n\n## Rules\n- Replace the indexed rule.\n");

		await withProjectMemoryLease(projectCwd, "test-holder", async () => {
			expect(searchProjectMemory(projectCwd, "indexed rule")).toEqual([
				expect.objectContaining({ content: "Keep the indexed rule." }),
			]);
		});
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

	it("removes stale distilled artifacts when their project files are deleted", async () => {
		const projectCwd = join(root, "stale-artifact-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const runAgent = vi.fn();
		runAgent.mockImplementationOnce(async () => {
			writeMemoryFile(
				join(projectCwd, ".cast", "skills", "release-check", "SKILL.md"),
				"---\nname: release-check\ndescription: Verify releases.\n---\n\nRun the release checks.",
			);
			return { messages: [{ role: "assistant" as const, content: "Created one skill." }] };
		});
		runAgent.mockResolvedValueOnce({ messages: [{ role: "assistant" as const, content: "No files remain." }] });

		await distillProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [{ role: "user", content: "distill release workflow" }],
			runAgent,
		});
		rmSync(join(projectCwd, ".cast", "skills"), { recursive: true, force: true });

		const result = await distillProjectMemory({
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [{ role: "user", content: "reconcile deleted release workflow" }],
			runAgent,
		});

		expect(result.artifacts).toEqual([]);
		expect(listProjectMemoryArtifacts(projectCwd)).toEqual([]);
	});

	it("does not leave artifact metadata when materialization fails", async () => {
		const projectCwd = join(root, "failed-artifact-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		appendMessage(session, { role: "user", content: "release-check release-check" });
		appendMessage(session, { role: "assistant", content: "release-check release-check" });
		saveSession(session);
		mkdirSync(join(projectCwd, ".cast", "skills"), { recursive: true });
		writeFileSync(join(projectCwd, ".cast", "skills", "release-check"), "blocking file", "utf8");
		vi.mocked(streamAndCollect).mockResolvedValueOnce({
			content: JSON.stringify({
				artifacts: [
					{
						kind: "skill",
						name: "release-check",
						description: "release-check workflow",
						content: "Run the release checks.",
					},
				],
			}),
		});

		await expect(
			distillProjectMemory({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [{ role: "user", content: "distill this workflow" }],
			}),
		).rejects.toThrow();
		expect(listProjectMemoryArtifacts(projectCwd)).toEqual([]);
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

	it("runs enabled automatic dream and distill passes once per interval", async () => {
		const realHome = process.env.HOME;
		const fakeHome = join(root, "home");
		process.env.HOME = fakeHome;
		const projectCwd = join(root, "auto-maintenance-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const runAgent = vi.fn(async () => ({ messages: [{ role: "assistant" as const, content: "done" }] }));
		const input = {
			cwd: projectCwd,
			sessionId: session.id,
			model: session.model,
			config: testConfig,
			messages: [{ role: "user" as const, content: "current work" }],
			runAgent,
		};
		try {
			updateSettings({
				memoryDreamAuto: true,
				memoryDreamIntervalDays: 0,
				memoryDistillAuto: true,
				memoryDistillIntervalDays: 0,
			});
			await maybeRunAutomaticMemoryMaintenance(input);
			await maybeRunAutomaticMemoryMaintenance(input);
			expect(runAgent).toHaveBeenCalledTimes(2);
			const runs = listAutomaticMemoryRuns(session.id);
			expect(runs.map((run) => run.kind)).toEqual(expect.arrayContaining(["dream", "distill"]));
			expect(runs.flatMap((run) => getSessionEvents(run.sessionId).map((event) => event.type))).toEqual(
				expect.arrayContaining(["memory_auto_dream_started", "memory_auto_distill_started"]),
			);
			expect(getSessionEvents(session.id).map((event) => event.type)).not.toContain("memory_auto_dream_started");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("persists automatic maintenance as an independently inspectable background run", async () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home-background-run");
		const projectCwd = join(root, "background-run-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const runAgent = vi.fn(async () => ({ messages: [{ role: "assistant" as const, content: "done" }] }));
		try {
			updateSettings({ memoryDreamAuto: true, memoryDreamIntervalDays: 0 });
			await maybeRunAutomaticMemoryMaintenance({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [],
				runAgent,
			});
			expect(listAutomaticMemoryRuns(session.id)).toEqual([
				expect.objectContaining({
					parentSessionId: session.id,
					kind: "dream",
					status: "success",
				}),
			]);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("keeps the automatic scheduler claim durable before an actor is spawned", async () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home-durable-scheduler-claim");
		const projectCwd = join(root, "durable-scheduler-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		getDb()
			.prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
			.run(new Date(Date.now() - 3 * 86_400_000).toISOString(), session.id);
		const runAgent = vi.fn(async () => ({ messages: [{ role: "assistant" as const, content: "unexpected" }] }));
		try {
			updateSettings({ memoryDreamAuto: true, memoryDreamIntervalDays: 1 });
			getDb()
				.prepare("INSERT INTO memory_maintenance_schedule (project_id, kind, last_claimed_at) VALUES (?, ?, ?)")
				.run(projectIdForCwd(projectCwd), "dream", new Date().toISOString());
			const result = await maybeRunAutomaticMemoryMaintenance({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [],
				runAgent,
			});
			expect(result).toEqual([]);
			expect(runAgent).not.toHaveBeenCalled();
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("isolates automatic maintenance in its own background session", async () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home-isolated-background-session");
		const projectCwd = join(root, "isolated-background-session-project");
		const session = createSession("test-model", projectCwd);
		appendMessage(session, { role: "user", content: "parent conversation" });
		saveSession(session);
		const runAgent = vi.fn(async () => ({
			messages: [{ role: "assistant" as const, content: "maintenance result" }],
		}));
		try {
			updateSettings({ memoryDreamAuto: true, memoryDreamIntervalDays: 0 });
			await maybeRunAutomaticMemoryMaintenance({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: session.messages,
				runAgent,
			});

			const [run] = listAutomaticMemoryRuns(session.id);
			expect(run).toBeDefined();
			expect(run?.sessionId).toBe(run?.id);
			expect(run?.sessionId).not.toBe(session.id);
			const background = loadSession(run!.sessionId);
			expect(background).toMatchObject({
				id: run!.sessionId,
				title: "Auto Dream",
				sessionKind: "background",
				backgroundKind: "memory-dream",
			});
			expect(background?.parentSessionId).toBe(session.id);
			expect(getFullHistory(background!.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ content: expect.stringContaining("maintenance result") }),
				]),
			);
			expect(getSessionEvents(background!.id).map((event) => event.type)).toEqual(
				expect.arrayContaining(["memory_auto_dream_started", "memory_dream_completed"]),
			);
			expect(getSessionEvents(session.id).map((event) => event.type)).not.toContain("memory_dream_completed");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("cancels an automatic maintenance background run by id", async () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home-cancel-background-run");
		const projectCwd = join(root, "cancel-background-run-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		let started!: () => void;
		const runStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const runAgent = vi.fn(async (input: { signal?: AbortSignal }) => {
			started();
			await new Promise<void>((_resolve, reject) => {
				if (input.signal?.aborted) return reject(new Error("aborted"));
				input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return { messages: [{ role: "assistant" as const, content: "unreachable" }] };
		});
		try {
			updateSettings({ memoryDreamAuto: true, memoryDreamIntervalDays: 0 });
			const pending = maybeRunAutomaticMemoryMaintenance({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [],
				runAgent,
			});
			await runStarted;
			const run = listAutomaticMemoryRuns(session.id).find((item) => item.status === "running");
			expect(run).toBeDefined();
			expect(cancelAutomaticMemoryRun(run!.id)).toBe(true);
			await pending;
			expect(listAutomaticMemoryRuns(session.id)).toEqual([
				expect.objectContaining({ id: run!.id, status: "cancelled" }),
			]);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
	});

	it("does not schedule automatic maintenance when memory writing is disabled", async () => {
		const realHome = process.env.HOME;
		process.env.HOME = join(root, "home-write-off");
		const projectCwd = join(root, "auto-write-off-project");
		const session = createSession("test-model", projectCwd);
		saveSession(session);
		const runAgent = vi.fn(async () => ({ messages: [{ role: "assistant" as const, content: "done" }] }));
		try {
			updateSettings({ memoryWriteEnabled: false, memoryDreamAuto: true, memoryDreamIntervalDays: 0 });
			await maybeRunAutomaticMemoryMaintenance({
				cwd: projectCwd,
				sessionId: session.id,
				model: session.model,
				config: testConfig,
				messages: [],
				runAgent,
			});
			expect(runAgent).not.toHaveBeenCalled();
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
		}
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
		expect(await waitForProjectCheckpointWriter(projectCwd, "session-writer-drain", 1)).toBe("timed-out");
		expect(handle.status()).toBe("running");
		release();
		expect(await handle.wait()).toBe("success");
	});
});
