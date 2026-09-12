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

const ARG_WHITESPACE_SPLIT = /\s+/;

// /memory subcommand parsing — ten subcommands, each a single regex. Lived
// as module-level constants in bridge.ts; moved here with the handlers
// since they belong to the same contract.
const MEMORY_WRITE_COMMAND_RE = /^write(?:\s+(on|off))?$/;
const MEMORY_BUDGET_COMMAND_RE = /^budget\s+(\d+)$/;
const MEMORY_FLOOR_COMMAND_RE = /^floor\s+(0(?:\.\d+)?|1(?:\.0)?)$/;
const MEMORY_RECONCILE_COMMAND_RE = /^reconcile\s+(on|off)$/;
const MEMORY_CHECKPOINT_FORK_COMMAND_RE = /^checkpoint\s+fork\s+(on|off)$/;
const MEMORY_CHECKPOINT_THRESHOLDS_COMMAND_RE = /^checkpoint\s+thresholds\s+(.+)$/;
const MEMORY_CHECKPOINT_RESERVED_COMMAND_RE = /^checkpoint\s+reserved\s+(\d+)$/;
const MEMORY_CHECKPOINT_CAPS_COMMAND_RE = /^checkpoint\s+caps\s+(.+)$/;
const MEMORY_AUTO_TOGGLE_COMMAND_RE = /^(dream|distill)\s+(on|off)$/;
const MEMORY_AUTO_INTERVAL_COMMAND_RE = /^(dream|distill)\s+interval\s+(\d+)$/;
const MEMORY_CANCEL_RUN_COMMAND_RE = /^cancel\s+([a-f0-9-]+)$/;

import type { AppConfig, ModelInfo } from "../../core/config.ts";
import { runHooksForEvent } from "../../core/hooks.ts";
import type { Message } from "../../core/llm.ts";
import { compactSessionMessages, runMemoryMaintenanceAgent } from "../../core/loop.ts";
import {
	cancelAutomaticMemoryRun,
	distillProjectMemory,
	dreamProjectMemory,
	listAutomaticMemoryRuns,
} from "../../core/memory.ts";
import type { Persona } from "../../core/personas.ts";
import type { resolveRulesForCwd } from "../../core/project.ts";
import { listHooksForCwdSettings, resolveHooksForCwd } from "../../core/project.ts";
import { formatRuleInvocation } from "../../core/rules.ts";
import type { SessionState } from "../../core/session.ts";
import { addUsage, clearSessionMessages, recordCompaction } from "../../core/session.ts";
import type { PermissionMode, Settings } from "../../core/settings.ts";
import {
	checkpointFork,
	memoryDistillAuto,
	memoryDistillIntervalDays,
	memoryDreamAuto,
	memoryDreamIntervalDays,
	updateSettings,
} from "../../core/settings.ts";
import type { ModelReasoningMeta, ReasoningFormat } from "../../core/vendors.ts";
import { buildReasoningParams, REASONING_FORMAT_OPTIONS, resolveReasoningFormat } from "../../core/vendors.ts";
import { ALL_THEMES } from "../../ui/themes/index.ts";
import type { SessionSummary, WebAgentSession } from "../bridge.ts";
import { buildGoalPrompt, parseGoalInput, REVIEW_PROMPT, SLASH_COMMANDS } from "../commands.ts";
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
	/** Full command string the bridge was given (e.g. "/rule:foo"). For
	 *  most commands this equals the registry key; for commands whose
	 *  first token carries data — `/rule:<id>` — it's the only way the
	 *  handler can read what came after the colon. */
	cmd: string;
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
	submit: (
		sessionId: string,
		text: string,
		images?: string[],
		clientMessageId?: string,
		queuedMessages?: Message[],
		opts?: { maxOuterIterations?: number },
	) => Promise<void>;
	/** Abort the running turn on the given session. */
	abort: (sessionId: string) => void;
	/** Create a new idle copy of the given session (used by /fork). */
	forkSessionInstance: (sessionId: string) => WebAgentSession | undefined;
	/** List every session summary the daemon knows about (used by /sessions). */
	listSessions: () => SessionSummary[];
	/** Whether the user has trusted the cwd's project to load its hooks file
	 *  — same gate fs-watcher uses. /hooks needs it to call
	 *  listHooksForCwdSettings. */
	trustForSessionCwd: (sessionCwd: string) => boolean;
	/** Mutate the bridge-local permission mode. /permissions needs this so
	 *  the next submit() picks up the new value without a server restart —
	 *  permissionMode is read fresh inside the agent loop. */
	setPermissionMode: (mode: PermissionMode) => void;
	/** Mutate the closure-local subagent model slot (read by the agent loop
	 *  fresh per run, like permissionMode). */
	setSubagentModel: (model: string | undefined) => void;
	/** Mutate the closure-local subagent provider slot. */
	setSubagentModelProvider: (provider: string | undefined) => void;
	/** Mutate the closure-local plan model slot. */
	setPlanModel: (model: string | undefined) => void;
	/** Mutate the closure-local plan provider slot. */
	setPlanModelProvider: (provider: string | undefined) => void;
	/** Mutate the closure-local quick-session persona slot — read by
	 *  `getConfig()` so the web sidebar reflects the latest choice.
	 *  Closure is seeded with DEFAULT_PERSONA so the slot is never
	 *  `undefined`; the setter accepts a string only. */
	setQuickSessionPersona: (name: string) => void;
	/** Current value of the closure-local quick-session persona slot
	 *  (always a string — the closure seeds it with DEFAULT_PERSONA when
	 *  loadSettings().quickSessionPersona is undefined). The no-arg
	 *  /quick-session-persona returns this verbatim. */
	quickSessionPersona: string;
	/** Current snapshot of the closure's persona list, used by
	 *  /quick-session-persona to list "Available: a, b, c" on an unknown
	 *  name. Captured at dispatch time so a /reload-driven refresh is
	 *  visible on the next command. */
	personas: Persona[];
	/** Default persona used as the fallback when resolvePersona fails. */
	currentPersona: Persona;
	/** Rebuilder for the per-session system prompt. Reads the closure's
	 *  skills, rules, and MCP — needs to live in the closure, so the
	 *  registry calls it back rather than re-implementing it. */
	computeSystemPrompt: (persona: Persona, model: string, sessionCwd: string, mode?: "plan" | "build") => string;
	/** Closure-local model-info lookup (cache-aware). /model uses it to
	 *  pick up the new model's reasoning metadata. */
	modelInfoFor: (model: string) => ModelInfo | undefined;
	/** Closure-local reasoning-option lookup (model + format aware). /reasoning
	 *  uses it to list/set the active level. */
	reasoningOptionsFor: (model: string) => Array<{ value: string; label: string }>;
	/** Resolve a sensible reasoning level for a model under a given format
	 *  and requested level. /reasoning and /reasoning-format use it to
	 *  re-derive config.reasoningLevel after a format/model switch. */
	reasoningLevelForModel: (model: string, format?: ReasoningFormat, requested?: string) => string;
	/** Mutate the closure-local defaultModel slot — the model new sessions
	 *  start on. /model writes it so the choice persists across /new. */
	setDefaultModel: (model: string) => void;
	/** Mutate the closure-local reasoningMeta. /model writes it so the next
	 *  /current and /reasoning read sees the new model's metadata. */
	setReasoningMeta: (meta: ModelReasoningMeta | undefined) => void;
	/** Spawn a fresh session — used by /new to hand back a sessionId the
	 *  client can switch to. Same shape as createSessionInstance inside
	 *  the bridge closure. */
	createSessionInstance: (
		personaName?: string,
		modelOverride?: string,
		cwdOverride?: string,
		runSessionStartHook?: boolean,
	) => WebAgentSession;
	/** Re-sync the FS watcher's per-session set (called by /compact when
	 *  it toggles ws.status to "running" and back). Closure-bound to
	 *  fsWatcher.syncFsWatcher. */
	syncFsWatcher: (ws: WebAgentSession) => void;
	/** Look up project rules (auto + always-apply) for the session's cwd.
	 *  Closure-bound to bridge.rulesForSessionCwd. /rules and /rule:<id>
	 *  use it; future rule-related commands can share. */
	rulesForSessionCwd: (sessionCwd: string) => ReturnType<typeof resolveRulesForCwd>;
	/** Side-effect: mark an auto-rule as "in flight" for the session,
	 *  so the next turn's system prompt re-injects it. /rule:<id> calls
	 *  this before submit() so the rule body survives the dispatch. */
	fireUserPromptExpansion: (sessionCwd: string, name: string) => void;
}

/** Handlers may be sync or async — async ones let /compact, /new, and any
 *  future command use await without each dispatch site having to special-
 *  case the return type. dispatchRegisteredCommand awaits the result so
 *  the bridge dispatcher sees a plain CommandResult either way. */
export type CommandHandler = (ctx: CommandContext) => CommandResult | Promise<CommandResult>;

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
	"/sessions": ({ listSessions }) => ({ ok: true, result: listSessions() }),
	"/hooks": ({ ws, arg, cwd, trustForSessionCwd }) => {
		const sessionCwd = ws.session.cwd ?? cwd;
		const [verb, ...rest] = arg.split(ARG_WHITESPACE_SPLIT).filter(Boolean);
		if (verb === "help") {
			return {
				ok: true,
				result: "/hooks – /hooks enable <id> – /hooks disable <id> — see docs/hooks.md",
			};
		}
		const { entries, diagnostics } = listHooksForCwdSettings(sessionCwd, trustForSessionCwd(sessionCwd));
		if (!verb) {
			return { ok: true, result: { entries, diagnostics } };
		}
		if (verb === "enable" || verb === "disable") {
			const id = rest.join(" ").trim();
			if (!id) return { ok: false, error: `Usage: /hooks ${verb} <id>` };
			if (!entries.some((e) => e.id === id)) return { ok: false, error: `No hook with id "${id}"` };
			updateSettings((current) => {
				const disabled = new Set(current.disabledHooks ?? []);
				if (verb === "disable") disabled.add(id);
				else disabled.delete(id);
				return { disabledHooks: [...disabled] };
			});
			return { ok: true, result: `Hook ${id} ${verb}d` };
		}
		return { ok: false, error: `Unknown /hooks ${verb}` };
	},
	"/turn-cap": ({ arg, loadSettings, turnIterationCap }) => {
		const settings = loadSettings();
		if (!arg)
			return {
				ok: true,
				result: `Turn iteration safety cap: ${turnIterationCap(settings)} (applies on the next turn)`,
			};
		if (arg === "reset" || arg === "off") {
			updateSettings({ maxTurnIterations: undefined });
			return { ok: true, result: "Turn iteration safety cap reset to default (500)." };
		}
		const n = Number(arg);
		if (!Number.isInteger(n) || n < 10 || n > 10_000) {
			return { ok: false, error: "Usage: /turn-cap <10-10000> | reset" };
		}
		updateSettings({ maxTurnIterations: n });
		return { ok: true, result: `Turn iteration safety cap set to ${n} (applies on the next turn).` };
	},
	"/permissions": ({ arg, permissionMode, setPermissionMode }) => {
		// Global, like /reasoning and /web — `permissionMode` is bridge-level
		// mutable state read fresh by submit() on the next run.
		if (!arg) return { ok: true, result: { permissionMode } };
		if (arg !== "default" && arg !== "bypass") return { ok: false, error: "Usage: /permissions default|bypass" };
		setPermissionMode(arg);
		updateSettings({ permissionMode: arg });
		return { ok: true, result: { permissionMode: arg } };
	},
	"/web": ({ arg, loadSettings }) => {
		// A global setting (matches the TUI/`cast run`'s own /web and
		// core/run.ts) — takes effect on the NEXT turn in every session, since
		// submit() reads `loadSettings().webTools` fresh each run rather than
		// caching it, same as headless mode does.
		if (!arg) return { ok: true, result: { webTools: loadSettings().webTools === true } };
		if (arg !== "on" && arg !== "off") return { ok: false, error: "Usage: /web on|off" };
		updateSettings({ webTools: arg === "on" });
		return { ok: true, result: { webTools: arg === "on" } };
	},
	"/web-search-provider": ({ arg, loadSettings }) => {
		// Same fresh-read pattern as /web — the next web_search call picks
		// this up via loadSettings() inside execWebSearch, no restart needed.
		if (!arg) {
			const s = loadSettings();
			return {
				ok: true,
				// Only whether a key is saved — the key itself never goes to the browser.
				result: {
					searchProvider: s.searchProvider ?? "ddg",
					hasTavilyApiKey: !!s.tavilyApiKey,
					hasBraveApiKey: !!s.braveApiKey,
				},
			};
		}
		const [provider, ...rest] = arg.split(ARG_WHITESPACE_SPLIT);
		if (provider === "ddg") {
			updateSettings({ searchProvider: "ddg" });
			return { ok: true, result: { searchProvider: "ddg" } };
		}
		if (provider === "tavily") {
			const key = rest.join(" ").trim() || loadSettings().tavilyApiKey;
			if (!key) return { ok: false, error: "Usage: /web-search-provider tavily <api-key>" };
			updateSettings({ searchProvider: "tavily", tavilyApiKey: key });
			return { ok: true, result: { searchProvider: "tavily", hasTavilyApiKey: true } };
		}
		if (provider === "brave") {
			const key = rest.join(" ").trim() || loadSettings().braveApiKey;
			if (!key) return { ok: false, error: "Usage: /web-search-provider brave <api-key>" };
			updateSettings({ searchProvider: "brave", braveApiKey: key });
			return { ok: true, result: { searchProvider: "brave", hasBraveApiKey: true } };
		}
		return { ok: false, error: "Usage: /web-search-provider ddg | tavily <api-key> | brave <api-key>" };
	},
	"/web-fetch-provider": ({ arg, loadSettings }) => {
		// Same fresh-read pattern as /web-search-provider — the next
		// web_fetch call picks this up via loadSettings() inside
		// execWebFetch, no restart needed.
		if (!arg) {
			return { ok: true, result: { webFetchProvider: loadSettings().webFetchProvider ?? "jina" } };
		}
		if (arg !== "jina" && arg !== "local") {
			return { ok: false, error: "Usage: /web-fetch-provider jina | local" };
		}
		updateSettings({ webFetchProvider: arg });
		return { ok: true, result: { webFetchProvider: arg } };
	},
	"/theme": ({ arg, loadSettings }) => {
		// A UI preference, not agent state — shared with the TUI's settings.json
		// `theme` field so picking one here also changes what `cast` shows next.
		if (!arg) {
			const current = loadSettings().theme ?? "cast";
			return { ok: true, result: { theme: current } };
		}
		const found = ALL_THEMES.find((t) => t.id === arg);
		if (!found) {
			return {
				ok: false,
				error: `Unknown theme: ${arg}. Available: ${ALL_THEMES.map((t) => t.id).join(", ")}`,
			};
		}
		updateSettings({ theme: found.id });
		return { ok: true, result: { theme: found.id, label: found.label, colors: found.colors } };
	},
	"/statusbar": ({ loadSettings }) => {
		return { ok: true, result: loadSettings().statusBar ?? { visible: [], order: [], sides: {} } };
	},
	"/reasoning-display": ({ loadSettings }) => {
		const next = !(loadSettings().showReasoning ?? true);
		updateSettings({ showReasoning: next });
		return { ok: true, result: { showReasoning: next } };
	},
	"/rd": ({ loadSettings }) => {
		const next = !(loadSettings().showReasoning ?? true);
		updateSettings({ showReasoning: next });
		return { ok: true, result: { showReasoning: next } };
	},
	"/quick-session-persona": ({ arg, personas, setQuickSessionPersona, quickSessionPersona }) => {
		if (!arg) return { ok: true, result: { quickSessionPersona } };
		const persona = personas.find((p) => p.name === arg);
		if (!persona) {
			return {
				ok: false,
				error: `Unknown persona: ${arg}. Available: ${personas.map((p) => p.name).join(", ")}`,
			};
		}
		setQuickSessionPersona(persona.name);
		updateSettings({ quickSessionPersona: persona.name });
		return { ok: true, result: { quickSessionPersona: persona.name } };
	},
	"/subagent-model": ({ arg, setSubagentModel, subagentModel }) => {
		if (!arg) return { ok: true, result: { subagentModel: subagentModel ?? null } };
		if (arg === "off" || arg === "reset") {
			setSubagentModel(undefined);
			if (arg === "reset") {
				updateSettings({
					subagentModel: undefined,
					subagentModelProvider: undefined,
				});
			} else {
				updateSettings({ subagentModel: undefined });
			}
			return {
				ok: true,
				result: {
					subagentModel: null,
					...(arg === "reset" ? { subagentModelProvider: null } : {}),
				},
			};
		}
		setSubagentModel(arg);
		updateSettings({ subagentModel: arg });
		return { ok: true, result: { subagentModel: arg } };
	},
	"/subagent-model-provider": ({ arg, setSubagentModelProvider, subagentModelProvider }) => {
		if (!arg) return { ok: true, result: { subagentModelProvider: subagentModelProvider ?? null } };
		if (arg === "off" || arg === "reset") {
			setSubagentModelProvider(undefined);
			updateSettings({ subagentModelProvider: undefined });
			return { ok: true, result: { subagentModelProvider: null } };
		}
		setSubagentModelProvider(arg);
		updateSettings({ subagentModelProvider: arg });
		return { ok: true, result: { subagentModelProvider: arg } };
	},
	"/plan-model": ({ arg, setPlanModel, planModel }) => {
		if (!arg) return { ok: true, result: { planModel: planModel ?? null } };
		if (arg === "off" || arg === "reset") {
			setPlanModel(undefined);
			if (arg === "reset") {
				updateSettings({
					planModel: undefined,
					planModelProvider: undefined,
				});
			} else {
				updateSettings({ planModel: undefined });
			}
			return {
				ok: true,
				result: { planModel: null, ...(arg === "reset" ? { planModelProvider: null } : {}) },
			};
		}
		setPlanModel(arg);
		updateSettings({ planModel: arg });
		return { ok: true, result: { planModel: arg } };
	},
	"/plan-model-provider": ({ arg, setPlanModelProvider, planModelProvider }) => {
		if (!arg) return { ok: true, result: { planModelProvider: planModelProvider ?? null } };
		if (arg === "off" || arg === "reset") {
			setPlanModelProvider(undefined);
			updateSettings({ planModelProvider: undefined });
			return { ok: true, result: { planModelProvider: null } };
		}
		setPlanModelProvider(arg);
		updateSettings({ planModelProvider: arg });
		return { ok: true, result: { planModelProvider: arg } };
	},
	"/model": ({
		ws,
		arg,
		cwd,
		config,
		modelInfoFor,
		reasoningLevelForModel,
		computeSystemPrompt,
		currentPersona,
		personas,
		saveSession,
		broadcaster,
		setReasoningMeta,
		setDefaultModel,
	}) => {
		if (!arg) return { ok: true, result: { model: ws.session.model } };
		ws.session.model = arg;
		ws.session.providerUrl = config.baseURL;
		// Not resolved against a specific saved provider — this switches the
		// model on whatever's currently active, so any provider pin this
		// session had is no longer meaningful and must not be trusted stale.
		ws.session.providerName = undefined;
		setReasoningMeta(modelInfoFor(arg)?.reasoning);
		config.reasoningLevel = reasoningLevelForModel(arg);
		config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, arg);
		ws.systemPrompt = computeSystemPrompt(
			personas.find((p) => p.name === (ws.session.persona ?? "")) ?? currentPersona,
			arg,
			ws.session.cwd ?? cwd,
			ws.session.mode,
		);
		saveSession(ws.session);
		// Persist as the default for future sessions too — otherwise a model
		// switch only ever applied to the session it was issued on, and every
		// new session kept starting on whatever was active when the server
		// started (confirmed: switching M2 -> M3 then /new still opened M2).
		setDefaultModel(arg);
		updateSettings({ model: arg, reasoningLevel: config.reasoningLevel });
		// Sidebar footer reads the model off the session-list summary, not the
		// open session's live state — without this it kept showing the old
		// model until the turn ended (which resends it) or the page reloaded.
		broadcaster.broadcastSessionUpdate(ws);
		return { ok: true, result: { model: arg } };
	},
	"/reasoning": ({ ws, arg, config, reasoningOptionsFor }) => {
		const options = reasoningOptionsFor(ws.session.model);
		if (options.length === 0) {
			return {
				ok: true,
				result: {
					reasoningLevel: config.reasoningLevel,
					options: [],
					note: "This provider exposes no reasoning controls for this model.",
				},
			};
		}
		if (!arg)
			return {
				ok: true,
				result: { reasoningLevel: config.reasoningLevel, options: options.map((o) => o.value) },
			};
		if (!options.some((o) => o.value === arg)) {
			return {
				ok: false,
				error: `Unknown reasoning level: ${arg}. Options: ${options.map((o) => o.value).join(", ")}`,
			};
		}
		// Global, same as the TUI — `config` is a shared mutable object, so this
		// takes effect on the next turn in every session, not just this one.
		config.reasoningLevel = arg;
		config.reasoningParams = buildReasoningParams(arg, config.reasoningFormat, ws.session.model);
		updateSettings({ reasoningLevel: arg });
		return { ok: true, result: { reasoningLevel: arg } };
	},
	"/persona": ({ ws, arg, cwd, personas, computeSystemPrompt, saveSession }) => {
		if (!arg) return { ok: true, result: { persona: ws.session.persona } };
		const persona = personas.find((p) => p.name === arg);
		if (!persona) {
			return {
				ok: false,
				error: `Unknown persona: ${arg}. Available: ${personas.map((p) => p.name).join(", ")}`,
			};
		}
		ws.session.persona = persona.name;
		ws.systemPrompt = computeSystemPrompt(persona, ws.session.model, ws.session.cwd ?? cwd, ws.session.mode);
		saveSession(ws.session);
		return { ok: true, result: { persona: persona.name, label: persona.label } };
	},
	"/reasoning-format": ({ ws, arg, config, reasoningLevelForModel, loadSettings }) => {
		const current = config.reasoningFormat;
		const options = REASONING_FORMAT_OPTIONS.map((o) => o.value);
		if (!arg) return { ok: true, result: { reasoningFormat: current, options } };
		if (!options.includes(arg as ReasoningFormat)) {
			return { ok: false, error: `Unknown reasoning format: ${arg}. Options: ${options.join(", ")}` };
		}
		config.reasoningFormat = resolveReasoningFormat(config.baseURL, arg as ReasoningFormat);
		const selected = arg as ReasoningFormat;
		config.reasoningLevel = reasoningLevelForModel(ws.session.model, config.reasoningFormat);
		config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, ws.session.model);
		const settings = loadSettings();
		const providers = settings.providers?.map((provider) =>
			provider.url === config.baseURL && provider.apiKey === config.apiKey
				? { ...provider, reasoningFormat: selected }
				: provider,
		);
		updateSettings({ providers, reasoningLevel: config.reasoningLevel });
		return { ok: true, result: { reasoningFormat: config.reasoningFormat } };
	},
	"/clear": ({ ws, saveSession }) => {
		clearSessionMessages(ws.session);
		saveSession(ws.session);
		return { ok: true, result: "Context cleared" };
	},
	"/compact": async ({ ws, cwd, config, trustForSessionCwd, broadcaster, saveSession, syncFsWatcher }) => {
		if (ws.session.messages.length === 0) return { ok: true, result: "Nothing to compact yet" };
		const compactHooks = resolveHooksForCwd(ws.session.cwd ?? cwd, trustForSessionCwd(ws.session.cwd ?? cwd));
		const preCompact = await runHooksForEvent(compactHooks, {
			event: "PreCompact",
			cwd: ws.session.cwd ?? cwd,
			sessionId: ws.id,
			payload: { trigger: "manual" },
		});
		if (preCompact.blocked) return { ok: false, error: preCompact.reason ?? "Compaction blocked by hook" };
		// Runs the same async summarization call `submit()` uses for the agent
		// loop itself — returns immediately (matching submit()'s own
		// fire-and-forget shape) and reports the outcome over SSE via the
		// existing "compaction" event, which the client already renders as a
		// system-message row (see runAgentLoop's own auto-compaction, which
		// broadcasts the identical event shape).
		ws.status = "running";
		syncFsWatcher(ws);
		broadcaster.broadcast(ws, { type: "status", status: "running" });
		compactSessionMessages(ws.session.messages, config, ws.session.model, undefined, undefined, (usage) =>
			addUsage(ws.session, usage),
		)
			.then((result) => {
				ws.status = "idle";
				syncFsWatcher(ws);
				if (result.compacted) {
					recordCompaction(ws.session, ws.session.messages, result.messages);
					ws.session.messages = result.messages;
					broadcaster.broadcast(ws, {
						type: "compaction",
						messagesCompacted: result.messagesCompacted,
						tokensBefore: result.tokensBefore,
					});
					void runHooksForEvent(compactHooks, {
						event: "PostCompact",
						cwd: ws.session.cwd ?? cwd,
						sessionId: ws.id,
						payload: { trigger: "manual", messagesCompacted: result.messagesCompacted },
					});
				} else if (result.error) {
					broadcaster.broadcast(ws, { type: "error", message: `Compaction failed: ${result.error}` });
				}
				saveSession(ws.session);
				broadcaster.broadcast(ws, { type: "status", status: "idle" });
			})
			.catch((err: unknown) => {
				ws.status = "error";
				ws.error = err instanceof Error ? err.message : String(err);
				broadcaster.broadcast(ws, { type: "error", message: ws.error });
				broadcaster.broadcast(ws, { type: "status", status: "error" });
			});
		return { ok: true, result: "Compacting…" };
	},
	"/new": async ({ ws, createSessionInstance }) => {
		const newWs = await createSessionInstance(ws.session.persona ?? undefined, undefined, ws.session.cwd);
		return { ok: true, result: { sessionId: newWs.id } };
	},
	"/plan": (ctx) => switchMode(ctx, "plan"),
	"/build": (ctx) => switchMode(ctx, "build"),
	"/memory": ({ arg, ws, loadSettings }) => {
		const settings = loadSettings();
		if (!arg)
			return {
				ok: true,
				result: {
					memoryEnabled: settings.memoryEnabled !== false,
					memoryWriteEnabled: settings.memoryWriteEnabled !== false,
					checkpointFork: checkpointFork(settings),
					memoryPromptBudget: settings.memoryPromptBudget ?? 4096,
					memorySearchScoreFloor: settings.memorySearchScoreFloor ?? 0.15,
					memoryReconcileOnSearch: settings.memoryReconcileOnSearch !== false,
					memoryDreamAuto: memoryDreamAuto(settings),
					memoryDreamIntervalDays: memoryDreamIntervalDays(settings),
					memoryDistillAuto: memoryDistillAuto(settings),
					memoryDistillIntervalDays: memoryDistillIntervalDays(settings),
					checkpointThresholds: settings.checkpointThresholds ?? null,
					checkpointReserved: settings.checkpointReserved ?? null,
					checkpointPushCaps: settings.checkpointPushCaps ?? null,
				},
			};
		if (arg === "on" || arg === "off") {
			const memoryEnabled = arg === "on";
			updateSettings({ memoryEnabled });
			return { ok: true, result: { memoryEnabled } };
		}
		const writeMatch = arg.match(MEMORY_WRITE_COMMAND_RE);
		if (writeMatch) {
			const memoryWriteEnabled = writeMatch[1] ? writeMatch[1] === "on" : !(settings.memoryWriteEnabled !== false);
			updateSettings({ memoryWriteEnabled });
			return { ok: true, result: { memoryWriteEnabled } };
		}
		const budgetMatch = arg.match(MEMORY_BUDGET_COMMAND_RE);
		if (budgetMatch) {
			const memoryPromptBudget = Math.max(256, Math.min(Number(budgetMatch[1]), 16_384));
			updateSettings({ memoryPromptBudget });
			return { ok: true, result: { memoryPromptBudget } };
		}
		const floorMatch = arg.match(MEMORY_FLOOR_COMMAND_RE);
		if (floorMatch) {
			const memorySearchScoreFloor = Number(floorMatch[1]);
			updateSettings({ memorySearchScoreFloor });
			return { ok: true, result: { memorySearchScoreFloor } };
		}
		const reconcileMatch = arg.match(MEMORY_RECONCILE_COMMAND_RE);
		if (reconcileMatch) {
			const memoryReconcileOnSearch = reconcileMatch[1] === "on";
			updateSettings({ memoryReconcileOnSearch });
			return { ok: true, result: { memoryReconcileOnSearch } };
		}
		const checkpointForkMatch = arg.match(MEMORY_CHECKPOINT_FORK_COMMAND_RE);
		if (checkpointForkMatch) {
			const checkpointForkValue = checkpointForkMatch[1] === "on";
			updateSettings({ checkpointFork: checkpointForkValue });
			return { ok: true, result: { checkpointFork: checkpointForkValue } };
		}
		const checkpointThresholdsMatch = arg.match(MEMORY_CHECKPOINT_THRESHOLDS_COMMAND_RE);
		if (checkpointThresholdsMatch) {
			const raw = checkpointThresholdsMatch[1]!;
			if (raw.trim() === "default") {
				updateSettings({ checkpointThresholds: undefined });
				return { ok: true, result: { checkpointThresholds: undefined } };
			}
			const values = raw
				.split(",")
				.map((part) => Number(part.trim()))
				.filter((value) => Number.isFinite(value));
			if (values.length === 0 || values.some((value) => value <= 0 || value > 100)) {
				return { ok: false, error: "Checkpoint thresholds must be percentages like 20,40,60,80 or 'default'" };
			}
			updateSettings({ checkpointThresholds: values });
			return { ok: true, result: { checkpointThresholds: values } };
		}
		const checkpointReservedMatch = arg.match(MEMORY_CHECKPOINT_RESERVED_COMMAND_RE);
		if (checkpointReservedMatch) {
			const checkpointReserved = Number(checkpointReservedMatch[1]);
			if (!Number.isInteger(checkpointReserved) || checkpointReserved < 0) {
				return { ok: false, error: "Checkpoint reserved must be a non-negative token count" };
			}
			updateSettings({ checkpointReserved });
			return { ok: true, result: { checkpointReserved } };
		}
		const checkpointCapsMatch = arg.match(MEMORY_CHECKPOINT_CAPS_COMMAND_RE);
		if (checkpointCapsMatch) {
			const raw = checkpointCapsMatch[1]!;
			if (raw.trim() === "default") {
				updateSettings({ checkpointPushCaps: undefined });
				return { ok: true, result: { checkpointPushCaps: undefined } };
			}
			const caps: Record<string, number> = {};
			let invalid = false;
			for (const pair of raw.split(",")) {
				const [key, valueText] = pair.split("=");
				const keyTrimmed = key?.trim() ?? "";
				const value = Number(valueText?.trim());
				if (
					!["checkpoint", "memory", "notes", "global", "tasks"].includes(keyTrimmed) ||
					!Number.isFinite(value) ||
					value <= 0
				) {
					invalid = true;
					break;
				}
				caps[keyTrimmed] = Math.floor(value);
			}
			if (invalid || Object.keys(caps).length === 0) {
				return {
					ok: false,
					error: "Checkpoint caps must be like checkpoint=11000,memory=10000,notes=6000,global=6000,tasks=2000 or 'default'",
				};
			}
			updateSettings({ checkpointPushCaps: caps });
			return { ok: true, result: { checkpointPushCaps: caps } };
		}
		const autoToggleMatch = arg.match(MEMORY_AUTO_TOGGLE_COMMAND_RE);
		if (autoToggleMatch) {
			const enabled = autoToggleMatch[2] === "on";
			const update = autoToggleMatch[1] === "dream" ? { memoryDreamAuto: enabled } : { memoryDistillAuto: enabled };
			updateSettings(update);
			return { ok: true, result: update };
		}
		const autoIntervalMatch = arg.match(MEMORY_AUTO_INTERVAL_COMMAND_RE);
		if (autoIntervalMatch) {
			const days = Math.max(0, Math.min(Number(autoIntervalMatch[2]), 3_650));
			const update =
				autoIntervalMatch[1] === "dream" ? { memoryDreamIntervalDays: days } : { memoryDistillIntervalDays: days };
			updateSettings(update);
			return { ok: true, result: update };
		}
		if (arg === "runs") return { ok: true, result: { runs: listAutomaticMemoryRuns(ws.session.id) } };
		const cancelRunMatch = arg.match(MEMORY_CANCEL_RUN_COMMAND_RE);
		if (cancelRunMatch) {
			return { ok: true, result: { cancelled: cancelAutomaticMemoryRun(cancelRunMatch[1]!) } };
		}
		return {
			ok: false,
			error: "Usage: /memory on|off|write on|write off|checkpoint fork on|off|checkpoint thresholds <pct,..|default>|checkpoint reserved <tokens>|checkpoint caps <k=v,..|default>|budget <tokens>|dream on|off|dream interval <days>|distill on|off|distill interval <days>|runs|cancel <run-id>|floor <0..1>|reconcile on|off",
		};
	},
	"/dream": async (ctx) => runMemoryMaintenance(ctx, "dream"),
	"/distill": async (ctx) => runMemoryMaintenance(ctx, "distill"),
	"/continue": ({ ws, listSessions }) => {
		const others = listSessions()
			.filter((s) => s.id !== ws.id)
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		if (others.length === 0) return { ok: false, error: "No other sessions to continue" };
		return { ok: true, result: { sessionId: others[0]!.id } };
	},
	"/goal": ({ ws, arg, submit }) => {
		const { goal, maxIterations } = parseGoalInput(arg);
		if (!goal) return { ok: false, error: "Usage: /goal [N] <what to achieve>  (or /goal --steps N <desc>)" };
		// /goal is blocking (isCommandBlocking), so this only runs idle.
		// Kick off the autonomous run with the chosen iteration budget and
		// let the SSE stream carry the work.
		void submit(ws.id, buildGoalPrompt(goal, maxIterations), undefined, undefined, undefined, {
			maxOuterIterations: maxIterations,
		}).catch((error) => {
			console.error(`[cast server] /goal submit failed:`, error);
		});
		return { ok: true, result: `Working toward the goal autonomously (budget: ${maxIterations})…` };
	},
	"/review": ({ ws, submit }) => {
		// /review is blocking (isCommandBlocking), so this only runs idle.
		// Start the review turn without awaiting it — the SSE stream carries
		// the agent's work; the command just acknowledges the kick-off.
		void submit(ws.id, REVIEW_PROMPT).catch((error) => {
			console.error(`[cast server] /review submit failed:`, error);
		});
		return { ok: true, result: "Reviewing the session's work…" };
	},
	"/rules": ({ ws, cwd, rulesForSessionCwd }) => {
		// `sticky` is what the *daemon* has latched this session. The agent
		// loop runs here, so a TUI attached as a thin client has no idea which
		// auto rules already attached — it was reporting every one of them as
		// still waiting for a match, for the whole session.
		const stickyIds = new Set((ws.activeAutoRules ?? []).map((r) => r.id));
		return {
			ok: true,
			result: rulesForSessionCwd(ws.session.cwd ?? cwd).directoryRules.map((r) => ({
				id: r.id,
				name: r.name,
				description: r.description,
				applyMode: r.applyMode,
				sticky: stickyIds.has(r.id),
			})),
		};
	},
	"/rule:": ({ ws, cwd, cmd, rulesForSessionCwd, fireUserPromptExpansion, submit }) => {
		const ruleId = cmd.slice("/rule:".length);
		if (!ruleId) return { ok: false, error: "Usage: /rule:<name>" };
		// Submits the rule body as a real user turn (matches the TUI's
		// agent.submit(formatRuleInvocation(rule)) — it's not a silent system-
		// prompt injection), so it needs the same idle gate a plain message
		// submit would get if the composer weren't already disabled while running.
		if (ws.status === "running") {
			return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
		}
		const sessionRules = rulesForSessionCwd(ws.session.cwd ?? cwd).directoryRules;
		const rule = sessionRules.find((r) => r.id === ruleId) ?? sessionRules.find((r) => r.name === ruleId);
		if (!rule) return { ok: false, error: `Unknown rule: ${ruleId}. See /rules for the list.` };
		fireUserPromptExpansion(ws.session.cwd ?? cwd, rule.name);
		submit(ws.id, formatRuleInvocation(rule));
		return { ok: true, result: `Invoked rule: ${rule.name}` };
	},
};

/** Shared body of /dream and /distill — they differ only in which core
 *  function to call. Pulled out so both registry entries stay
 *  one-liners and the disable-checks live in one place. */
async function runMemoryMaintenance(
	{ ws, cwd, config, loadSettings }: CommandContext,
	kind: "dream" | "distill",
): Promise<CommandResult> {
	if (loadSettings().memoryEnabled === false) return { ok: false, error: "Project memory is disabled" };
	if (loadSettings().memoryWriteEnabled === false) return { ok: false, error: "Project memory writing is disabled" };
	try {
		const input = {
			cwd: ws.session.cwd ?? cwd,
			sessionId: ws.session.id,
			model: ws.session.model,
			config,
			messages: ws.session.messages,
			runAgent: runMemoryMaintenanceAgent,
		};
		if (kind === "dream") {
			const result = await dreamProjectMemory(input);
			return { ok: true, result: { removed: result.removed, stored: result.stored } };
		}
		const result = await distillProjectMemory(input);
		return { ok: true, result: { artifacts: result.artifacts } };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Shared body of /plan and /build — the only difference is the mode and
 *  the human-readable confirmation string. Pulled out as a top-level
 *  helper so both registry entries stay one-liners. */
function switchMode(
	{ ws, cwd, personas, currentPersona, computeSystemPrompt, saveSession, broadcaster }: CommandContext,
	mode: "plan" | "build",
): CommandResult {
	ws.session.mode = mode;
	ws.systemPrompt = computeSystemPrompt(
		personas.find((p) => p.name === (ws.session.persona ?? "")) ?? currentPersona,
		ws.session.model,
		ws.session.cwd ?? cwd,
		mode,
	);
	// Same reasoning as setSessionMode: a stale plan question/transition
	// left over from before this mode switch must not survive it — see
	// that function's comment for the full failure mode.
	if (ws.session.planQuestion || ws.session.planTransition) {
		broadcaster.persistDecisionState(ws, undefined, undefined);
	} else {
		saveSession(ws.session);
	}
	return {
		ok: true,
		result:
			mode === "plan"
				? "Plan mode — read-only exploration and planning; /build to exit"
				: "Build mode — full toolset",
	};
}

export const commandRegistry: Record<string, CommandHandler> = commandHandlers;

/**
 * Dispatch a command by name through the registry. Returns the handler's
 * result, or `undefined` if no handler is registered for this name —
 * `bridge.executeCommand` falls through to its inline logic in that case.
 * Async handlers are awaited so the bridge dispatcher always sees a plain
 * CommandResult.
 */
export async function dispatchRegisteredCommand(name: string, ctx: CommandContext): Promise<CommandResult | undefined> {
	// /rule:NAME is one token (no space before the rule id) — the bridge
	// handles it before this gate and checks `running` internally.
	if (name.startsWith("/rule:")) {
		return await commandRegistry["/rule:"]?.(ctx);
	}
	const handler = commandRegistry[name];
	if (!handler) return undefined;
	return await handler(ctx);
}
