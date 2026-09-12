/**
 * Command registry — a dispatch table for `bridge.executeCommand(name, args)`.
 *
 * Moved out of server/bridge.ts in two TDD slices. Slice 1 registered the
 * read-only "session info" commands (`/help`, `/usage`). Slice 2 added
 * `/current` and `/repo`, which need a wider context (cwd fallback, config,
 * loadSettings, etc) — see `CommandContext` below. The dispatcher in
 * bridge.ts still falls through to the inline logic for commands not yet
 * registered, so additional slices can land incrementally.
 *
 * The seam under test (web-bridge.test.ts) is `bridge.executeCommand(name)`;
 * these handlers are tested through it, not directly.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AppConfig } from "../../core/config.ts";
import type { Message } from "../../core/llm.ts";
import type { SessionState } from "../../core/session.ts";
import type { PermissionMode, Settings } from "../../core/settings.ts";
import type { WebAgentSession } from "../bridge.ts";
import { SLASH_COMMANDS } from "../commands.ts";
import type { Broadcaster } from "./broadcaster.ts";

/**
 * Public result shape of `bridge.executeCommand`. Defined here (not imported
 * from bridge.ts) so command-registry.ts has zero runtime coupling to the
 * closure module — bridge.ts re-exports the same shape so external callers
 * see one type.
 */
export interface CommandResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/**
 * Context handed to every registered command handler. Slice 1 only used
 * `ws` and `arg`; slice 2 grew it to the full set of helpers that
 * `/current` and `/repo` needed. Future slices will keep adding fields
 * rather than create a new context type per handler — keeping one
 * context interface keeps the dispatcher signature stable and lets
 * bridge.ts build it once.
 */
export interface CommandContext {
	ws: WebAgentSession;
	arg: string;
	/** Bridge's cwd fallback when a session has no cwd of its own. */
	cwd: string;
	config: AppConfig;
	loadSettings: () => Settings;
	sessionReasoningLevel: (ws: WebAgentSession) => string;
	countTurnMessages: (messages: Message[]) => number;
	permissionMode: PermissionMode;
	subagentModel: string | null;
	subagentModelProvider: string | null;
	planModel: string | null;
	planModelProvider: string | null;
	turnIterationCap: (settings: Settings) => number;
	/** Persist a freshly-built message into a session's transcript. */
	appendMessage: (session: SessionState, message: Message) => void;
	/** Flush a session to disk (called by handlers that mutate ws.session). */
	saveSession: (session: SessionState) => void;
	/** Broadcast primitives — plan-note and other session-mutating commands
	 *  fire plan_decision / session_update events through this. */
	broadcaster: Broadcaster;
	/** Fire-and-forget submit — used when /steer or /queue hit an idle
	 *  session and need to kick off a normal turn. Matches the original
	 *  inline behaviour: the call returns immediately; the turn runs in
	 *  the background. */
	submit: (sessionId: string, text: string) => void;
	/** Abort the running turn on the given session. */
	abort: (sessionId: string) => void;
	/** Create a new idle copy of the given session (used by /fork). */
	forkSessionInstance: (sessionId: string) => WebAgentSession | undefined;
}

/** Synchronous handlers — async work happens before this entry point. */
export type CommandHandler = (ctx: CommandContext) => CommandResult;

/**
 * Renders the visible-command list as a markdown block — same output the
 * inline `getHelpText` closure used to produce. Hidden commands
 * (MCP/skills/provider/SSH/theme/...) live in the Settings modal now, so
 * they're filtered out here. The exact set of visible commands drives
 * the "Blocking" footer too, so the help text stays self-consistent
 * with `isCommandBlocking` even as commands are added or hidden.
 */
function getHelpText(): string {
	const visible = SLASH_COMMANDS.filter((c) => !c.hidden);
	const lines = visible.map((c) => `- \`${c.name}\` — ${c.description}`);
	const blocking = visible.filter((c) => c.blocking).map((c) => c.name);
	return [
		"**Available commands:**",
		"",
		...lines,
		"",
		`*Blocking (require idle): ${blocking.join(", ")}. Everything else works while the agent runs.*`,
		"",
		"*MCP, skills, provider, SSH, theme, model/reasoning details, and usage live in Settings (gear icon).*",
	].join("\n");
}

const commandHandlers: Record<string, CommandHandler> = {
	"/help": () => ({ ok: true, result: getHelpText() }),
	"/usage": ({ ws }) => ({ ok: true, result: ws.session.usage }),
	"/current": (ctx) => {
		const {
			ws,
			config,
			loadSettings,
			sessionReasoningLevel,
			countTurnMessages,
			permissionMode,
			subagentModel,
			subagentModelProvider,
			planModel,
			planModelProvider,
			turnIterationCap,
		} = ctx;
		return {
			ok: true,
			result: {
				persona: ws.session.persona,
				model: ws.session.model,
				providerUrl: ws.session.providerUrl ?? config.baseURL,
				providerName:
					ws.session.providerName ??
					(loadSettings().providers ?? []).find(
						(provider) => provider.url === config.baseURL && provider.apiKey === config.apiKey,
					)?.name ??
					null,
				reasoningLevel: sessionReasoningLevel(ws),
				mode: ws.session.mode ?? "build",
				status: ws.status,
				messageCount: countTurnMessages(ws.session.messages),
				usage: ws.session.usage,
				lastTurn: ws.lastTurn,
				permissionMode,
				subagentModel: subagentModel ?? null,
				subagentModelProvider: subagentModelProvider ?? null,
				planModel: planModel ?? null,
				planModelProvider: planModelProvider ?? null,
				maxTurnIterations: turnIterationCap(loadSettings()),
			},
		};
	},
	"/repo": (ctx) => {
		const { ws, cwd } = ctx;
		const sessionCwd = ws.session.cwd ?? cwd;
		const git = (args: string[]) =>
			execFileSync("git", args, {
				cwd: sessionCwd,
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		try {
			git(["rev-parse", "--is-inside-work-tree"]);
		} catch {
			return { ok: true, result: { cwd: sessionCwd, isGit: false } };
		}
		let branch = "—";
		let dirty = false;
		try {
			branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		} catch {}
		try {
			dirty = git(["status", "--porcelain"]).length > 0;
		} catch {}
		let worktree: string | null = null;
		try {
			const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			const mainRepoRoot = join(commonDir, "..");
			const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
				cwd: mainRepoRoot,
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			const blocks = list.split("\n\n");
			for (const block of blocks) {
				const pathLine = block.split("\n").find((l) => l.startsWith("worktree "));
				if (!pathLine) continue;
				const path = pathLine.substring("worktree ".length);
				if (path === sessionCwd && path !== mainRepoRoot) {
					worktree = path;
					break;
				}
			}
		} catch {
			// git worktree list is best-effort; standalone clones without
			// registered worktrees leave worktree = null and the UI shows
			// the em-dash placeholder.
		}
		return {
			ok: true,
			result: { cwd: sessionCwd, isGit: true, branch, dirty, worktree },
		};
	},
	"/fork": ({ ws, forkSessionInstance }) => {
		const fork = forkSessionInstance(ws.id);
		if (!fork) return { ok: false, error: "Could not fork session" };
		return { ok: true, result: { sessionId: fork.id } };
	},
	"/plan-note": ({ ws, arg, appendMessage, saveSession, broadcaster }) => {
		if (!arg) return { ok: false, error: "Usage: /plan-note <decision>" };
		const content = `<system-reminder>${arg}</system-reminder>`;
		appendMessage(ws.session, { role: "user", content });
		saveSession(ws.session);
		broadcaster.broadcast(ws, { type: "plan_decision", content: arg });
		broadcaster.broadcastSessionUpdate(ws);
		return { ok: true, result: "Recorded" };
	},
	"/abort": ({ ws, abort }) => {
		abort(ws.id);
		return { ok: true, result: "Aborted" };
	},
	"/stop": ({ ws, abort }) => {
		abort(ws.id);
		return { ok: true, result: "Aborted" };
	},
	"/steer": ({ ws, arg, submit }) => {
		if (!arg) return { ok: false, error: "Usage: /steer <message> — injects it into the running turn" };
		if (ws.status !== "running") {
			submit(ws.id, arg);
			return { ok: true, result: "Sent" };
		}
		ws.runner.steeringQueue.enqueue({ role: "user", content: arg });
		return { ok: true, result: "Steered into the running turn" };
	},
	"/s": ({ ws, arg, submit }) => {
		if (!arg) return { ok: false, error: "Usage: /steer <message> — injects it into the running turn" };
		if (ws.status !== "running") {
			submit(ws.id, arg);
			return { ok: true, result: "Sent" };
		}
		ws.runner.steeringQueue.enqueue({ role: "user", content: arg });
		return { ok: true, result: "Steered into the running turn" };
	},
	"/queue": ({ ws, arg, submit }) => {
		if (!arg) return { ok: false, error: "Usage: /queue <message> — runs after the current turn" };
		if (ws.status !== "running") {
			submit(ws.id, arg);
			return { ok: true, result: "Sent" };
		}
		ws.runner.followUpQueue.enqueue({ role: "user", content: arg });
		return { ok: true, result: "Queued for after this turn" };
	},
	"/q": ({ ws, arg, submit }) => {
		if (!arg) return { ok: false, error: "Usage: /queue <message> — runs after the current turn" };
		if (ws.status !== "running") {
			submit(ws.id, arg);
			return { ok: true, result: "Sent" };
		}
		ws.runner.followUpQueue.enqueue({ role: "user", content: arg });
		return { ok: true, result: "Queued for after this turn" };
	},
	"/queue-reset": ({ ws }) => {
		ws.runner.followUpQueue.clear();
		return { ok: true, result: "Queue cleared" };
	},
	"/qr": ({ ws }) => {
		ws.runner.followUpQueue.clear();
		return { ok: true, result: "Queue cleared" };
	},
};

export const commandRegistry: Record<string, CommandHandler> = commandHandlers;

/**
 * Dispatch a command by name through the registry. Returns the handler's
 * result, or `undefined` if no handler is registered for this name —
 * `bridge.executeCommand` falls through to its inline logic in that case.
 */
export function dispatchRegisteredCommand(name: string, ctx: CommandContext): CommandResult | undefined {
	const handler = commandRegistry[name];
	if (!handler) return undefined;
	return handler(ctx);
}
