import { loadConfig, resolveProvider } from "../src/core/config.ts";
import { dirname, join } from "node:path";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	buildMemoryPrompt,
	createProjectMemoryService,
	extractAndStoreProjectMemory,
	searchProjectMemory,
	storeProjectMemory,
} from "../src/core/memory.ts";
import { runAgentLoop } from "../src/core/loop.ts";
import { createSession, saveSession } from "../src/core/session.ts";
import { loadSettings } from "../src/core/settings.ts";

const database = process.env.CAST_SESSIONS_DB;
if (!database || database === ":memory:") throw new Error("CAST_SESSIONS_DB must point to an isolated file database");
process.env.CAST_MEMORY_DIR ??= join(dirname(database), "memory");

const settings = loadSettings();
const providerName = process.env.CAST_E2E_PROVIDER ?? "minimax";
const provider = resolveProvider(
	settings.providers ?? [],
	providerName,
	{ baseURL: settings.providers?.[0]?.url ?? "", apiKey: settings.providers?.[0]?.apiKey ?? "" },
);
if (!provider.apiKey || !provider.baseURL) throw new Error(`Provider "${providerName}" is not configured`);

const config = loadConfig(provider);
const model = process.env.CAST_E2E_MODEL ?? "MiniMax-M3";
const cwd = process.cwd();
const memoryService = createProjectMemoryService();
const retrievalOnlyService = {
	...memoryService,
	extractAndStoreProjectMemory: async () => ({ entries: [], transcript: "", skipped: true }),
};

async function waitForMemory(query, predicate) {
	const deadline = Date.now() + 40_000;
	let matches = [];
	while (Date.now() < deadline) {
		matches = searchProjectMemory(cwd, query);
		if (matches.some(predicate)) return matches;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return matches;
}

const cases = [
	{
		name: "daemon event ordering",
		fact: "Cast must preserve monotonically increasing SSE event sequence numbers during reconnects.",
		query: "SSE sequence reconnect",
		match: /sequence|reconnect/i,
	},
	{
		name: "isolated test database",
		fact: "Cast tests must set CAST_SESSIONS_DB to an isolated temporary SQLite file.",
		query: "CAST_SESSIONS_DB isolated SQLite",
		match: /CAST_SESSIONS_DB|isolated|SQLite/i,
	},
	{
		name: "background task contract",
		fact: "A background bash launch returns a task_id immediately and later reports completion through the follow-up queue.",
		query: "background bash task_id follow-up",
		match: /task.?id|follow.?up|background/i,
	},
	{
		name: "file freshness",
		fact: "The web file explorer must invalidate its directory cache after a successful file mutation.",
		query: "file explorer directory cache mutation",
		match: /cache|mutation|file/i,
	},
	{
		name: "attachment send gate",
		fact: "The composer must keep send disabled until every selected attachment has finished uploading.",
		query: "composer attachment uploading send disabled",
		match: /upload|send|attachment/i,
	},
	{
		name: "session pagination",
		fact: "Large session transcripts must load through cursor-like history pages instead of one unbounded response.",
		query: "session transcript history pages",
		match: /history|page|transcript/i,
	},
	{
		name: "PTY lifecycle",
		fact: "A persistent terminal owns its PTY process and exposes explicit output, wait, and kill operations.",
		query: "persistent terminal PTY output kill",
		match: /PTY|terminal|kill/i,
	},
	{
		name: "reasoning round trip",
		fact: "OpenAI-compatible tool loops must round-trip native reasoning metadata on assistant tool-call messages.",
		query: "reasoning metadata tool-call round-trip",
		match: /reasoning|tool.?call|round.?trip/i,
	},
	{
		name: "documentation validation",
		fact: "Documentation changes must be checked through the documentation build and browser smoke test before release.",
		query: "documentation build browser smoke test",
		match: /documentation|browser|smoke/i,
	},
	{
		name: "connection status",
		fact: "The web connection indicator reflects the backend heartbeat and turns stale after reconnect timeout.",
		query: "web connection heartbeat reconnect timeout",
		match: /heartbeat|reconnect|connection/i,
	},
];

const results = [];
for (const [caseIndex, testCase] of cases.entries()) {
	const marker = `CAST_MEMORY_CASE_${String(caseIndex + 1).padStart(2, "0")}`;
	let sessionId = "";
	let matches = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		sessionId = `e2e-memory-${Date.now()}-${caseIndex}-${attempt}`;
		const session = createSession(model, cwd);
		session.id = sessionId;
		saveSession(session);
		const memoryMessages = [
			{
				role: "user",
				content: `Remember this durable project fact exactly. Keep the marker unchanged: ${marker}. Fact: ${testCase.fact} Confirm briefly and do not call tools.`,
			},
			{ role: "assistant", content: "Acknowledged." },
		];
		await runAgentLoop(memoryMessages,
			{
				config,
				model,
				cwd,
				systemPrompt: "You are a coding agent. Confirm the user's durable project fact briefly and do not call tools.",
				memory: { sessionId },
				onEvent: () => {},
			},
		);
		await extractAndStoreProjectMemory({ cwd, sessionId, model, config, messages: memoryMessages, signal: AbortSignal.timeout(60_000) });
		matches = await waitForMemory(marker, (match) => match.content.includes(marker));
		if (matches.some((match) => match.content.includes(marker))) break;
	}
	if (!matches.some((match) => match.content.includes(marker))) {
		throw new Error(`Case "${testCase.name}" was not stored after retries: ${JSON.stringify(matches)}`);
	}

	const prompt = buildMemoryPrompt(cwd, marker);
	const secondMessages = await runAgentLoop(
		[
			{
				role: "user",
				content: `Answer using the durable project memory if it is relevant. Include this exact marker and one concrete detail: ${marker}. Keep it to one sentence.`,
			},
		],
		{
			config,
			model,
			cwd,
			systemPrompt: `${prompt}\nAnswer from project memory in one short sentence.`,
			memory: { sessionId: `${sessionId}-reader`, service: retrievalOnlyService },
			onEvent: () => {},
		},
	);
	const answer = [...secondMessages].reverse().find((message) => message.role === "assistant");
	const answerText = typeof answer?.content === "string" ? answer.content : "";
	if (!testCase.match.test(answerText)) throw new Error(`Case "${testCase.name}" was not recalled: ${answerText}`);
	results.push({ name: testCase.name, marker, stored: matches.length, recalled: true });
}

const raceFact = { content: "Concurrent writers must collapse to one fingerprinted memory row.", type: "race" };
await Promise.all(
	Array.from({ length: 20 }, (_, index) =>
		Promise.resolve().then(() => storeProjectMemory(cwd, `race-session-${index}`, "same-turn", [raceFact])),
	),
);
const raceMatches = searchProjectMemory(cwd, "concurrent writers fingerprinted");
if (raceMatches.filter((match) => match.content === raceFact.content).length !== 1) {
	throw new Error(`Concurrent memory writes were not deduplicated: ${JSON.stringify(raceMatches)}`);
}

const claimMessages = [{ role: "user", content: "Remember this durable claim test: the writer must run once." }];
const claimSession = `e2e-memory-claim-${Date.now()}`;
const claimInput = { cwd, sessionId: claimSession, model, config, messages: claimMessages };
const claimResults = await Promise.all([
	extractAndStoreProjectMemory(claimInput),
	extractAndStoreProjectMemory(claimInput),
]);
if (claimResults.filter((result) => result.skipped).length !== 1) {
	throw new Error(`Extraction claim did not suppress the duplicate writer: ${JSON.stringify(claimResults)}`);
}

console.log(
	JSON.stringify(
		{
			provider: provider.baseURL,
			model,
			cases: results.length,
			results,
			concurrentWrite: "deduplicated",
			duplicateWriter: "suppressed",
		},
		null,
		2,
	),
);

resetDbConnectionForTests();
