import { describe, expect, it, vi } from "vitest";
import {
	canSendToDaemon,
	loadDaemonPendingState,
	parseDaemonPendingState,
	parseQuestionToolResult,
} from "../src/ui/useAgentSession.ts";

describe("parseQuestionToolResult", () => {
	const validContent = JSON.stringify({
		question: true,
		questions: [
			{
				question: "Choose cache backend",
				options: [
					{ value: "memory", label: "In-memory" },
					{ value: "redis", label: "Redis" },
				],
				recommended: "redis",
			},
		],
		note: "The user will choose in the picker.",
	});

	it("extracts the question schema from the question tool result content", () => {
		expect(parseQuestionToolResult(validContent)).toEqual({
			questions: [
				{
					question: "Choose cache backend",
					options: [
						{ value: "memory", label: "In-memory" },
						{ value: "redis", label: "Redis" },
					],
					recommended: "redis",
				},
			],
		});
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseQuestionToolResult("not json")).toBeUndefined();
	});

	it("returns undefined when the payload carries no questions array", () => {
		expect(parseQuestionToolResult(JSON.stringify({ question: true }))).toBeUndefined();
	});

	it("returns undefined for an empty questions array", () => {
		expect(parseQuestionToolResult(JSON.stringify({ question: true, questions: [] }))).toBeUndefined();
	});
});

describe("parseDaemonPendingState", () => {
	it("gates only thin-client sends on the daemon SSE connection", () => {
		expect(canSendToDaemon(false, false)).toBe(true);
		expect(canSendToDaemon(true, false)).toBe(false);
		expect(canSendToDaemon(true, true)).toBe(true);
	});

	it("restores persisted questions and plan approvals after reconnect", () => {
		expect(
			parseDaemonPendingState({
				question: { questions: [{ question: "Choose database", options: [{ value: "sqlite", label: "SQLite" }] }] },
				planTransition: { kind: "done" },
				status: "idle",
			}),
		).toEqual({
			question: { questions: [{ question: "Choose database", options: [{ value: "sqlite", label: "SQLite" }] }] },
			planTransition: { kind: "done" },
			status: "idle",
		});
	});

	it("surfaces the backend turnStartedAt so the elapsed timer resumes across reconnect", () => {
		expect(
			parseDaemonPendingState({
				status: "running",
				turnStartedAt: 1789000000123,
			}),
		).toEqual({
			status: "running",
			startedAt: 1789000000123,
		});
	});

	it("fetches persisted decisions from the daemon when no SSE event was observed", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						question: {
							questions: [{ question: "Choose database", options: [{ value: "sqlite", label: "SQLite" }] }],
						},
						planTransition: { kind: "done" },
						status: "idle",
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				loadDaemonPendingState({ baseUrl: "http://daemon.test", token: "test-token" }, "session-1"),
			).resolves.toEqual({
				question: { questions: [{ question: "Choose database", options: [{ value: "sqlite", label: "SQLite" }] }] },
				planTransition: { kind: "done" },
				status: "idle",
			});
			expect(fetchMock).toHaveBeenCalledWith(
				"http://daemon.test/api/v1/sessions/session-1",
				expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
