/**
 * ACP agent — wires `@agentclientprotocol/sdk`'s typed `agent({ name })`
 * factory to cast's `AgentRunner`, session, and plan primitives.
 *
 * The adapter (`AcpAdapter`, in bridge.ts) owns the runner per session and
 * translates `AgentEvent` → SDK `sessionUpdate` notifications.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { StartupResult } from "../startup.ts";
import { type AcpAdapterSession, createAcpAdapter } from "./bridge.ts";

function identity<T>(x: T): T {
	return x;
}

/** Build the configured ACP `AgentApp` from cast startup + options. Exposed
 * for integration tests that wire the same handlers through an in-memory
 * stream pair instead of `process.stdin` / `process.stdout`. */
export function buildAcpAgentApp(
	startup: StartupResult,
	opts: { version: string; permissionMode: "bypass" | "default"; sessionId?: string; resume?: boolean },
): { app: ReturnType<typeof acp.agent>; sessions: Map<string, AcpAdapterSession> } {
	const adapter = createAcpAdapter(opts);
	const app = acp.agent({ name: "cast" });

	const sessions = new Map<string, AcpAdapterSession>();

	app.onRequest(acp.AGENT_METHODS.initialize, (ctx): acp.InitializeResponse => {
		return adapter.initialize(ctx.params) as acp.InitializeResponse;
	})
		.onRequest(acp.AGENT_METHODS.authenticate, (): acp.AuthenticateResponse => ({}))
		.onRequest(acp.AGENT_METHODS.session_new, (): acp.NewSessionResponse => {
			const session = adapter.newSession(startup, opts);
			sessions.set(session.state.id, session);
			return { sessionId: session.state.id };
		})
		.onRequest(acp.AGENT_METHODS.session_load, (ctx): acp.LoadSessionResponse => {
			const session = adapter.loadSession(ctx.params.sessionId, startup, opts, ctx.client);
			if (!session) {
				throw new acp.RequestError(-32004, `Session ${ctx.params.sessionId} not found`, {
					sessionId: ctx.params.sessionId,
				});
			}
			sessions.set(session.state.id, session);
			return { configOptions: [] };
		})
		.onRequest(acp.AGENT_METHODS.session_close, async (ctx): Promise<void> => {
			await adapter.closeSession(ctx.params.sessionId, sessions);
		})
		.onRequest(acp.AGENT_METHODS.session_resume, (ctx): acp.ResumeSessionResponse => {
			const session = adapter.loadSession(ctx.params.sessionId, startup, opts, ctx.client);
			if (!session) {
				throw new acp.RequestError(-32004, `Session ${ctx.params.sessionId} not found`, {
					sessionId: ctx.params.sessionId,
				});
			}
			sessions.set(session.state.id, session);
			return { configOptions: [] };
		})
		.onRequest(acp.AGENT_METHODS.session_list, (ctx): acp.ListSessionsResponse => {
			return adapter.listSessions(ctx.params) as acp.ListSessionsResponse;
		})
		.onRequest(acp.AGENT_METHODS.session_set_mode, (ctx): acp.SetSessionModeResponse => {
			const session = sessions.get(ctx.params.sessionId);
			if (!session) return {};
			return adapter.setSessionMode(ctx.params.modeId, session, ctx.client);
		})
		.onRequest(acp.AGENT_METHODS.session_prompt, async (ctx): Promise<acp.PromptResponse> => {
			const session = sessions.get(ctx.params.sessionId);
			if (!session) return { stopReason: "cancelled" };
			return (await adapter.submitPrompt(
				ctx.params.sessionId,
				ctx.params.prompt,
				session,
				ctx.client,
				opts,
			)) as unknown as acp.PromptResponse;
		})
		.onNotification(acp.AGENT_METHODS.session_cancel, (ctx): void => {
			const session = sessions.get(ctx.params.sessionId);
			if (!session) return;
			adapter.cancel(session);
		})
		.onRequest("answer_question", identity as (p: unknown) => any, async (ctx): Promise<unknown> => {
			const params = ctx.params as { sessionId: string; answers: string[] };
			const session = sessions.get(params.sessionId);
			if (!session) return {};
			await adapter.answerQuestion(params.sessionId, params.answers, session, ctx.client);
			return {};
		})
		.onRequest("plan_review", identity as (p: unknown) => any, async (ctx): Promise<unknown> => {
			const params = ctx.params as { sessionId: string; choice: "continue" | "retry" | "clean" };
			const session = sessions.get(params.sessionId);
			if (!session) return {};
			await adapter.planReview(params.sessionId, params.choice, session);
			return {};
		});

	return { app, sessions };
}

export function runAcpAgent(
	startup: StartupResult,
	opts: { version: string; permissionMode: "bypass" | "default"; sessionId?: string; resume?: boolean },
) {
	const { app } = buildAcpAgentApp(startup, opts);

	const input = new WritableStream<Uint8Array>({
		write(chunk) {
			process.stdout.write(chunk);
		},
	});
	const output = new ReadableStream<Uint8Array>({
		start(controller) {
			const { stdin } = process;
			if (!stdin.isTTY) {
				stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
				stdin.on("end", () => controller.close());
			}
		},
	});
	const stream = acp.ndJsonStream(input, output);
	app.connect(stream);
}
