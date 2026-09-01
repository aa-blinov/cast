/**
 * Web agent bridge — wraps core/loop.ts + core/runner.ts for web clients.
 * Each WebAgentSession has its own AgentRunner and runs runAgentLoop in the
 * background. SSE listeners receive AgentEvent broadcasts in real time.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import chokidar from "chokidar";
import { subscribeAgentActorNotifications } from "../core/actor-events.ts";
import type { AgentActorNotification } from "../core/actors.ts";
import { backupFileForCheckpoint, createCheckpoint, restoreCheckpoint } from "../core/checkpoint.ts";
import { fetchModels, type ModelInfo, probeProvider, resolveProvider } from "../core/config.ts";
import { hasHooks, runHooksForEvent } from "../core/hooks.ts";
import { createClient, type Message, streamAndCollect } from "../core/llm.ts";
import { type AgentEvent, compactSessionMessages, runAgentLoop, runMemoryMaintenanceAgent } from "../core/loop.ts";
import { closeMcpConnections, formatMcpForPrompt, type McpSetupResult } from "../core/mcp.ts";
import {
	cancelAutomaticMemoryRun,
	distillProjectMemory,
	dreamProjectMemory,
	listAutomaticMemoryRuns,
} from "../core/memory.ts";
import { DEFAULT_PERSONA, type Persona } from "../core/personas.ts";
import {
	createPlanState,
	createPlanTodos,
	modeDisabledTools,
	type PlanQuestion,
	resolvePlanQuestion,
	resolvePlanTransition,
} from "../core/plan.ts";
import {
	addMarketplace,
	ensureDefaultMarketplaces,
	getMarketplaceCatalog,
	installPlugin,
	listInstalledPlugins,
	listKnownMarketplaces,
	removeMarketplace,
	setPluginEnabled,
	uninstallPlugin,
	updateMarketplace,
} from "../core/plugins.ts";
import {
	buildSystemPrompt,
	discoverSkillsForCwd,
	listHooksForCwdSettings,
	readSkillsShSources,
	removeMcpServerFromDisk,
	resolveHooksForCwd,
	resolveMcpForCwd,
	resolvePersonasForCwd,
	resolveProjectTrustForCwd,
	resolveRulesForCwd,
	resolveSkillsForCwd,
} from "../core/project.ts";
import { getModelsCache, setModelsCache } from "../core/readline.ts";
import { formatRuleInvocation } from "../core/rules.ts";
import { type AgentRunner, createAgentRunner } from "../core/runner.ts";
import {
	addUsage,
	appendCheckpoint,
	appendMessage,
	appendSessionEvent,
	type SessionSummary as CoreSessionSummary,
	clearSessionMessages,
	countTurnMessages,
	createSession,
	deleteSession,
	dropLastCheckpoint,
	forkSession,
	getFullHistory,
	getHistoryPage,
	listSessionSummaries,
	loadSession,
	loadSessionByShareToken,
	loadSessionMeta,
	recordCompaction,
	resetSessionContext,
	type SessionState,
	saveSession,
	searchSessionSummaries,
	type TurnMeta,
	updateLastCheckpoint,
} from "../core/session.ts";
import {
	checkpointFork,
	loadSettings,
	memoryDistillAuto,
	memoryDistillIntervalDays,
	memoryDreamAuto,
	memoryDreamIntervalDays,
	turnIterationCap,
	updateSettings,
} from "../core/settings.ts";
import {
	formatSkillInvocation,
	formatSkillsForPrompt,
	isUninstallableSkill,
	uninstallUserSkill,
} from "../core/skills.ts";
import { saveSshConfig } from "../core/ssh.ts";
import type { StartupResult } from "../core/startup.ts";
import { classifyLlmError, recordLlmCompaction, recordLlmRequest, recordToolCall } from "../core/telemetry.ts";
import { stripAnsi } from "../core/tools/bash.ts";
import { BackgroundTaskRegistry, type BashBackgroundDeps } from "../core/tools/bash-background.ts";
import { type CompletedToolCallStatus, completedToolCallStatus } from "../core/tools/shared.ts";
import { effectiveStatusFromFile } from "../core/turn-runner-state.ts";
import {
	buildReasoningParams,
	getDefaultReasoningLevel,
	getReasoningOptionsForFormat,
	REASONING_FORMAT_OPTIONS,
	type ReasoningFormat,
	resolveReasoningFormat,
} from "../core/vendors.ts";
import { ensureSessionWorktree, listWorktrees, removeWorktreeBySlug, type SessionWorktree } from "../core/worktree.ts";
import { ALL_THEMES } from "../ui/themes/index.ts";
import type { ThemeColors } from "../ui/themes/types.ts";
import { buildGoalPrompt, isCommandBlocking, parseGoalInput, REVIEW_PROMPT, SLASH_COMMANDS } from "./commands.ts";
import { sessionInputsDir } from "./inputs.ts";

const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\//i;
const FRONTMATTER_STRIP_RE = /^---\n[\s\S]*?\n---\n?/;
const WORKTREE_REMOVE_PREFIX_RE = /^(?:remove|rm)\s*(.*)$/;
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
// Shared markdown code-fence stripping — parseSuggestionJson/parseEvolveJson
// tolerate a model wrapping its JSON in a ```json fence; generateSkillBody
// tolerates any language tag (or none) around a SKILL.md body. All three
// close on a bare trailing ``` fence.
const JSON_FENCE_OPEN_RE = /^```(?:json)?\s*/i;
const CODE_FENCE_OPEN_RE = /^```[^\n]*\n/;
const CODE_FENCE_CLOSE_RE = /```\s*$/;
const EVOLVE_SYSTEM_PROMPT =
	"You analyze a coding-agent session and propose reusable project skills (SKILL.md) worth creating, grouped by the typical tasks this project keeps doing. Reply with valid JSON only.";
const EVOLVE_PROMPT = `Below is a transcript of the current session (assistant messages and tool results, newest last), plus the project's typical tasks.

Identify the recurring, reusable procedures this session performed that a future session in THIS project would genuinely benefit from following again — e.g. "run the dev server and verify with curl", "add a component with tests", "cut a release", "run a specific migration". Group each proposal around a typical task for this project.

For each, reply with one object in a JSON array (nothing else, no markdown):
[{"name": "short-kebab-case-name", "description": "one sentence: when to use this procedure in this project"}]

Only include procedures that are clearly reusable and project-specific. If the session was one-off or nothing is reusable, reply with an empty array [].

Project typical tasks:
{{PROJECT}}

<transcript>
{{TRANSCRIPT}}
</transcript>`;
const CLIENT_PARITY_COMMANDS = new Set([
	"/quit",
	"/exit",
	"/copy",
	"/older",
	"/keys",
	"/statusbar",
	"/reasoning-display",
	"/rd",
	"/reasoning-format",
	"/memory",
	"/dream",
	"/distill",
	"/worktree",
]);

const execFileAsync = promisify(execFile);

// Slash-command argument parsing pulls the same one-or-more-whitespace
// regex into every branch (every command dispatches via `arg.split(WHITESPACE_SPLIT)`).
// Hoisting to module scope avoids re-parsing the pattern on every
// keystroke-level command.
const WHITESPACE_SPLIT = /\s+/;
// `skills.sh install <URL>` accepts a github URL but our CLI hands the
// string to `npx` verbatim and `npx` expects `owner/repo`. Strip a leading
// `https?://(www.)?github.com/` so a paste from the skills.sh site
// "just works" no matter how the user copied the URL. Used twice in the
const GITHUB_GIT_SUFFIX = /\.git$/;

async function runSkillsSh(args: string[], timeout: number): Promise<string> {
	// `npx skills add` is a TTY-bound CLI — it walks the user through a
	// scope prompt before installing. Cast already passes a specific skill
	// name (and optionally a repo), so the only remaining prompt is the
	// project-vs-global question. `-y` short-circuits it (auto-detect:
	// `global` when the CLI is invoked from a non-project cwd, which is
	// `homedir()` for us). Any caller already passing `-y` (rare) is
	// left alone.
	const fullArgs = args.includes("-y") || args.includes("--yes") ? args : [...args, "-y"];
	try {
		const { stdout, stderr } = await execFileAsync("npx", ["--yes", "skills", ...fullArgs], {
			cwd: homedir(),
			encoding: "utf-8",
			timeout,
		});
		const out = stripAnsi(stdout).trim();
		const err = stripAnsi(stderr || "").trim();
		// Surface stderr warnings (e.g. "Failed to install 1") even on success
		if (err && !out.includes(err)) return err ? `${out}\n${err}`.trim() : out;
		return out;
	} catch (error) {
		const execError = error as { stdout?: string; stderr?: string; message?: string };
		const out = stripAnsi(execError.stdout || "").trim();
		const err = stripAnsi(execError.stderr || execError.message || String(error)).trim();
		const combined = [out, err].filter(Boolean).join("\n").trim();
		throw new Error(combined || "skills.sh failed");
	}
}

export type WebAgentStatus = "idle" | "running" | "error";

export type WebEvent =
	| AgentEvent
	| { type: "status"; status: WebAgentStatus; startedAt?: number }
	| {
			type: "user_message";
			message: {
				role: "user";
				content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
				clientMessageId?: string;
			};
	  }
	| { type: "session_update"; session: SessionSummary }
	| { type: "decision_state"; question: PlanQuestion | undefined; planTransition: { kind: "done" } | undefined }
	| { type: "session_end"; usage: SessionState["usage"]; messageCount: number }
	| { type: "session_closed" }
	| { type: "turn_meta"; model: string; provider: string; totalMs: number }
	| { type: "plan_decision"; content: string }
	/** Non-error status message (e.g. an automatic model switch) — the client
	 * renders it as a warning row in the transcript, unlike "error" which
	 * fails the turn. */
	| { type: "notice"; message: string }
	/** Watcher in `ws.cwd` saw changes while the session was idle. Only fired
	 * when nothing else is broadcasting — tool_end already covers active turns.
	 * Client should re-fetch the diff (and re-read the file tree). */
	| { type: "fs_change" }
	| { type: "agent_actor"; actor: AgentActorNotification };

export interface WebAgentSession {
	id: string;
	session: SessionState;
	runner: AgentRunner;
	backgroundBash: BashBackgroundDeps;
	status: WebAgentStatus;
	error: string | null;
	/** Epoch milliseconds, owned by the backend so a page reload can resume the
	 * live request timer instead of starting it from zero. */
	turnStartedAt?: number;
	/** Current in-flight assistant blocks. Ephemeral: returned on reload, but
	 * never persisted as transcript history and cleared when the turn settles. */
	activeStream?: DisplayStreamBlock[];
	listeners: Set<(event: WebEvent) => void>;
	/** IDs accepted while this live session has queued work. Persisted user
	 * messages are checked as well, so a lost HTTP response can be retried
	 * without creating a duplicate turn. */
	acceptedClientMessageIds: Set<string>;
	/** The clientMessageId of the turn currently being processed — telemetry
	 * groups llm_requests and tool_calls by it (turn-level aggregates). */
	currentClientMessageId?: string;
	/** Rebuilt whenever persona or model changes — see `computeSystemPrompt`. */
	systemPrompt: string;
	/** Ephemeral, like the TUI's `lastTurnUsage` (useAgentSession.ts) — not
	 * persisted to disk, cleared implicitly by just being overwritten each
	 * turn. Surfaced via /current. */
	lastTurn?: {
		generationMs?: number;
		tokensPerSecond?: number;
		completedAt: string;
		model?: string;
		provider?: string;
		totalMs?: number;
	};
}

export interface SessionSummary {
	id: string;
	persona: string;
	model: string;
	cwd: string;
	title?: string;
	pinned?: boolean;
	status: WebAgentStatus;
	/** True when the session runs in its own throwaway sandbox folder
	 * (~/.cast/sandbox/cast-<id>) — the UI warns that deleting the session
	 * also deletes that folder. */
	isSandbox?: boolean;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface DisplayToolCall {
	id: string;
	name: string;
	args: string;
	status: CompletedToolCallStatus;
	result: string;
	/** Set for a `read` on an image file — the photo it returned, so the UI
	 * can show it inside this card instead of as an unexplained separate
	 * message below (see toDisplayMessages' castToolCallId handling). */
	images?: string[];
}

export type DisplayStreamBlock =
	| { order: number; kind: "thinking" | "content"; text: string }
	| {
			order: number;
			kind: "tool";
			call: Omit<DisplayToolCall, "status"> & { status: "running" | CompletedToolCallStatus };
	  };

function appendActiveText(
	blocks: DisplayStreamBlock[] | undefined,
	kind: "thinking" | "content",
	text: string,
	order: number,
): DisplayStreamBlock[] {
	const current = blocks ?? [];
	for (let i = current.length - 1; i >= 0; i--) {
		const block = current[i];
		if (block.kind === "tool") break;
		if (block.kind === kind) {
			return [...current.slice(0, i), { ...block, text: block.text + text }, ...current.slice(i + 1)];
		}
	}
	return [...current, { order, kind, text }];
}

/** UI-friendly shape — matches what the client already builds live from SSE
 * events (see app.js's "assistant_message" handler), so a history reload
 * (GET /api/sessions/:id) renders identically to a freshly-streamed turn. */
export interface DisplayMessage {
	role: string;
	content: string | null;
	clientMessageId?: string;
	/** Persistent row sequence, used by the web client to retain DOM identity
	 * when an SSE reconnect refreshes the latest history page. */
	seq?: number;
	toolCalls?: DisplayToolCall[];
	thinking?: string;
	turnMeta?: TurnMeta;
	/** data: URLs from a `read` on an image file (see loop.ts's imageDataUrl
	 * handling) — carried on the synthetic `role: "user"` message the loop
	 * pushes after such a tool result, since a plain string `content` can't
	 * hold both text and inline images. */
	images?: string[];
}

export function reconcileActiveStream(
	messages: DisplayMessage[],
	stream: DisplayStreamBlock[] | null | undefined,
): { messages: DisplayMessage[]; streaming: DisplayStreamBlock[] | null } {
	if (!stream || stream.length === 0) return { messages, streaming: null };
	const activeContentBlock = stream.find((block) => block.kind === "content");
	const activeContent = activeContentBlock && "text" in activeContentBlock ? activeContentBlock.text : undefined;
	const activeThinking = stream
		.filter((block) => block.kind === "thinking" && "text" in block)
		.map((block) => ("text" in block ? block.text : ""))
		.join("");
	const activeTools = stream.filter(
		(block): block is Extract<DisplayStreamBlock, { kind: "tool" }> => block.kind === "tool",
	);
	const activeToolIds = new Set(activeTools.map((block) => block.call.id));
	let targetIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (
			message.role === "assistant" &&
			((activeContent !== undefined && message.content === activeContent) ||
				message.toolCalls?.some((call) => activeToolIds.has(call.id)))
		) {
			targetIndex = i;
			break;
		}
	}
	if (targetIndex < 0) return { messages, streaming: stream };
	const nextMessages = messages.slice();
	const target = { ...nextMessages[targetIndex]! };
	if (activeThinking && !target.thinking) target.thinking = activeThinking;
	if (target.content == null && activeContent !== undefined) target.content = activeContent;
	if (target.toolCalls) {
		target.toolCalls = target.toolCalls.map((call) => {
			const activeTool = activeTools.find((block) => block.call.id === call.id);
			return activeTool ? { ...call, result: activeTool.call.result, images: activeTool.call.images } : call;
		});
	}
	nextMessages[targetIndex] = target;
	const remaining = stream.filter((block) => {
		if (block.kind === "thinking") return false;
		if (block.kind === "content") return target.content !== block.text;
		return block.kind !== "tool" || !activeToolIds.has(block.call.id);
	});
	return { messages: nextMessages, streaming: remaining.length > 0 ? remaining : null };
}

/**
 * Session storage keeps the raw OpenAI wire format: assistant messages carry
 * `tool_calls` (snake_case, `{id, function:{name,arguments}}`) with their
 * results as separate trailing `{role:"tool", tool_call_id, content}`
 * messages, and a tool-only turn's `content` is the sentinel `null` (see
 * core/loop.ts) rather than an empty string. Sent as-is, the client would
 * stringify that `null` into the literal text "null" and have no `toolCalls`
 * array to render a card from. This folds each assistant message's tool
 * calls and their matching results together and drops the (i.e. already
 * merged-in) `tool` messages entirely. `reasoning` (SessionState's sidecar
 * map, index -> thinking text — see core/session.ts) reattaches each
 * assistant message's reasoning so a reload looks the same as a live turn.
 * `turnMeta` is the same kind of sidecar map for the "provider · model · Ns"
 * footer under whichever assistant message actually ended a turn.
 */
/** Strips every `<system-reminder>...</system-reminder>` block out of `text`,
 *  returning the visible remainder plus each reminder's body separately —
 *  shared by both branches below (plain-string user messages, and the
 *  array-content branch for a message that also carries images) so a
 *  reminder is never left as raw XML in what the user sees. */
function extractSystemReminders(text: string): { cleaned: string; reminders: string[] } {
	const reminders: string[] = [];
	const cleaned = text
		.replace(SYSTEM_REMINDER_RE, (_, body: string) => {
			reminders.push(body.trim());
			return "";
		})
		.trim();
	return { cleaned, reminders };
}

/** Parse the skill-suggest eval verdict. Robust to MiniMax inlining its
 * chain-of-thought into `content` before the JSON instead of putting it in a
 * reasoning field — the JSON substring is extracted and parsed. */
export function parseSuggestionJson(content: string): { name: string; description: string } | null {
	const cleaned = content.replace(JSON_FENCE_OPEN_RE, "").replace(CODE_FENCE_CLOSE_RE, "").trim();
	const candidates = [cleaned];
	const firstBrace = cleaned.indexOf("{");
	const lastBrace = cleaned.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as { name?: unknown; description?: unknown };
			if (typeof parsed.name === "string" && parsed.name.trim() && typeof parsed.description === "string") {
				return { name: parsed.name.trim(), description: parsed.description.trim() };
			}
		} catch {
			// Not JSON in this form — try the next candidate.
		}
	}
	return null;
}

/** /evolve suggestion: a reusable skill worth capturing for this project,
 *  scoped to a typical task the session was doing. */
export interface EvolveSkillSuggestion {
	name: string;
	description: string;
}

/** Parse the /evolve verdict. The model returns a JSON array of skill
 *  suggestions (or an empty array); inline chain-of-thought before the JSON
 *  is tolerated, matching parseSuggestionJson's robustness. */
export function parseEvolveJson(content: string): EvolveSkillSuggestion[] {
	const cleaned = content.replace(JSON_FENCE_OPEN_RE, "").replace(CODE_FENCE_CLOSE_RE, "").trim();
	const candidates = [cleaned];
	const firstBrace = cleaned.indexOf("[");
	const lastBrace = cleaned.lastIndexOf("]");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (Array.isArray(parsed)) {
				return parsed
					.filter(
						(item): item is { name?: unknown; description?: unknown } =>
							typeof item === "object" && item !== null,
					)
					.map((item) => ({
						name: typeof item.name === "string" ? item.name.trim() : "",
						description: typeof item.description === "string" ? item.description.trim() : "",
					}))
					.filter((item) => item.name && item.description);
			}
		} catch {
			// Not JSON in this form — try the next candidate.
		}
	}
	return [];
}

export function toDisplayMessages(
	messages: Message[],
	reasoning?: Record<number, string>,
	turnMeta?: Record<number, TurnMeta>,
	// Both needed to build an out-of-band image URL (`/api/sessions/:id/image?
	// seq=&idx=`) instead of inlining the data: URL — a handful of read photos
	// otherwise turns every session load into a multi-MB JSON payload. Falls
	// back to inlining when either is missing (e.g. a message not yet
	// persisted, so it has no seq — happens during a live-streaming turn).
	sessionId?: string,
	seqs?: number[],
	imageApiPrefix = "/api",
): DisplayMessage[] {
	// Pre-index tool results by call_id — turns O(N*M) lookups into O(M).
	const toolResults = new Map<string, Message>();
	for (const m of messages) {
		if (m.role === "tool" && "tool_call_id" in m && m.tool_call_id) toolResults.set(m.tool_call_id, m);
	}
	// Same, for a `read`-on-image-file's synthetic image_url message (see
	// loop.ts's castToolCallId) — keyed so the image renders inside the
	// originating ToolCard instead of as an unexplained message below it.
	// Resolved once here (URL vs inline, per this function's own rule) so the
	// second pass below can just look it up.
	const imagesByToolCallId = new Map<string, string[]>();
	messages.forEach((m, i) => {
		if (m.role !== "user" || !Array.isArray(m.content)) return;
		const toolCallId = (m as { castToolCallId?: string }).castToolCallId;
		if (!toolCallId) return;
		const dataUrls = (m.content as Array<{ type?: string; image_url?: { url?: string } }>)
			.filter((p) => p.type === "image_url" && p.image_url?.url)
			.map((p) => p.image_url!.url!);
		if (dataUrls.length === 0) return;
		const seq = seqs?.[i];
		imagesByToolCallId.set(
			toolCallId,
			sessionId && seq !== undefined
				? dataUrls.map((_, idx) => `${imageApiPrefix}/sessions/${sessionId}/image?seq=${seq}&idx=${idx}`)
				: dataUrls,
		);
	});
	const out: DisplayMessage[] = [];
	messages.forEach((m, i) => {
		if (m.role === "tool") return;
		if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
			const toolCalls: DisplayToolCall[] = m.tool_calls
				.filter((tc) => tc.type === "function")
				.map((tc) => {
					const resultMsg = toolResults.get(tc.id);
					const images = imagesByToolCallId.get(tc.id);
					return {
						id: tc.id,
						name: tc.function.name,
						args: tc.function.arguments,
						status: completedToolCallStatus((resultMsg as { castIsError?: boolean } | undefined)?.castIsError),
						result: resultMsg ? String(resultMsg.content ?? "") : "",
						...(images ? { images } : {}),
					};
				});
			out.push({
				role: "assistant",
				content: typeof m.content === "string" ? m.content : null,
				seq: seqs?.[i],
				toolCalls,
				thinking: reasoning?.[i],
				turnMeta: turnMeta?.[i],
			});
			return;
		}
		// Array `content` on a role:"user" message is either a `read`-on-
		// image-file's synthetic relay (no text part — see loop.ts's
		// castToolCallId comment; already attributed to its ToolCard above,
		// skipped here so it doesn't also render as a separate floating
		// message) or a real turn with an attached photo (a text part is
		// always present, even empty — see bridge.ts's buildUserContent).
		// Sessions saved before castToolCallId existed have neither tag, so
		// they still fall through to the inline rendering below.
		if (m.role === "user" && Array.isArray(m.content)) {
			const toolCallId = (m as { castToolCallId?: string }).castToolCallId;
			if (toolCallId && imagesByToolCallId.has(toolCallId)) return;
			const parts = m.content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
			const dataUrls = parts.filter((p) => p.type === "image_url" && p.image_url?.url).map((p) => p.image_url!.url!);
			// Present-but-empty text (a caption-less real send — see buildUserContent,
			// which always includes this part) must stay distinguishable from no
			// text part at all (the tool-only relay) — the client uses exactly this
			// null-vs-string distinction to label the message "you" vs "image (read)".
			const textPartObj = parts.find((p) => p.type === "text");
			let textPart = textPartObj ? (textPartObj.text ?? "") : null;
			if (dataUrls.length > 0) {
				// A message with both images and an attached document (see
				// inputs.ts) carries its <system-reminder> inside this same text
				// part — extract it the same way the plain-string branch below
				// does, so it surfaces as a separate notice instead of leaking
				// raw <system-reminder> tags into the visible bubble.
				if (m.role === "user" && textPart) {
					const extracted = extractSystemReminders(textPart);
					for (const body of extracted.reminders) out.push({ role: "warning", content: `[system] ${body}` });
					textPart = extracted.cleaned || (textPart ? "" : null);
				}
				const seq = seqs?.[i];
				const images =
					sessionId && seq !== undefined
						? dataUrls.map((_, idx) => `${imageApiPrefix}/sessions/${sessionId}/image?seq=${seq}&idx=${idx}`)
						: dataUrls;
				out.push({
					role: m.role,
					content: textPart,
					seq: seqs?.[i],
					images,
					...((m as Message & { castClientMessageId?: string }).castClientMessageId
						? { clientMessageId: (m as Message & { castClientMessageId?: string }).castClientMessageId }
						: {}),
				});
				return;
			}
		}
		// Extract <system-reminder> blocks and render them as warning
		// messages instead of raw XML. These are internal protocol
		// (compaction, date-rollover, interrupt reminders, attached-file
		// notices) injected as role:"user" because the wire format has no
		// dedicated role.
		let content = typeof m.content === "string" ? m.content : null;
		if (m.role === "user" && content) {
			const { cleaned, reminders } = extractSystemReminders(content);
			// Show each reminder as a styled warning message
			for (const body of reminders) {
				if (body) out.push({ role: "warning", content: `[system] ${body}` });
			}
			if (cleaned) {
				content = cleaned;
			} else if (reminders.length > 0) {
				// Entire message was system-reminder — skip the user message
				// but reminders already added above
				return;
			}
		}
		out.push({
			role: m.role,
			content,
			seq: seqs?.[i],
			...((m as Message & { castClientMessageId?: string }).castClientMessageId
				? { clientMessageId: (m as Message & { castClientMessageId?: string }).castClientMessageId }
				: {}),
			thinking: m.role === "assistant" ? reasoning?.[i] : undefined,
			turnMeta: m.role === "assistant" ? turnMeta?.[i] : undefined,
		});
	});
	return out;
}

/** Sentinel the web client sends as `cwd` for a throwaway sandbox session. The
 * real directory (`~/.cast/sandbox/cast-<session id>`) is only derived
 * server-side once the session id exists — the client never holds a path that
 * hasn't been created yet, so it can't stat/open a missing one. */
export const SANDBOX_CWD = "sandbox";

export interface ServerBridge {
	createSession(
		personaName?: string,
		modelOverride?: string,
		cwdOverride?: string,
		runSessionStartHook?: boolean,
		worktree?: SessionWorktree,
		/** Provider name (from settings.providers) to pin this session to, instead of inheriting whatever's globally active right now. */
		providerOverride?: string,
	): WebAgentSession;
	/** Creates an idle copy of the current safe context and registers it as a new session. */
	forkSession(sessionId: string): WebAgentSession | undefined;
	getSession(id: string): WebAgentSession | undefined;
	listSessions(): SessionSummary[];
	/** Same shape as listSessions, filtered and ranked by relevance against
	 *  `query` (message content via SQLite FTS, plus cwd/id/title/persona/
	 *  model). Empty/whitespace-only query is equivalent to listSessions(). */
	searchSessions(query: string): SessionSummary[];
	/** Swaps in a freshly-connected MCP result — for the web daemon's deferred
	 *  startup (see ParsedArgs.deferMcp): the server starts with an
	 *  unconnected placeholder so it can begin listening immediately, then
	 *  calls this once the real background connect finishes. Every run reads
	 *  the current MCP result fresh at turn-start (same mechanism /mcp
	 *  enable/disable already uses), so the very next message in any open
	 *  session picks up the newly connected tools with no restart needed. */
	applyMcpResult(result: McpSetupResult): void;
	/** Aborts any in-flight run and drops the session from the live list — it
	 * stays on disk (autosaved already), it just stops appearing as a running
	 * background agent. Returns false if the id doesn't exist. `reason:
	 * "shutdown"` (used by the process shutdown handler) tells an in-flight
	 * run's interrupt reminder not to blame the user for a backend restart. */
	closeSession(sessionId: string, reason?: "shutdown"): boolean;
	/** Unlike closeSession, this actually removes the session (and its
	 * messages) from disk — not recoverable. Aborts/cleans up the live
	 * instance first if one exists. Returns false if the id doesn't exist
	 * either live or on disk. */
	deleteSessionPermanently(sessionId: string): boolean;
	/** Manual rename — overrides the auto-derived title permanently. Returns
	 * false if the id doesn't exist. Empty/whitespace-only clears back to
	 * showing the persona name. */
	renameSession(sessionId: string, title: string): boolean;
	/** Toggle pin-to-top in the session list. Returns false if the id doesn't exist. */
	pinSession(sessionId: string, pinned: boolean): boolean;
	/** Generates (or returns the existing) public `/shared/:token` link for a
	 * thread. Null if the session doesn't exist. */
	shareSession(sessionId: string): { token: string } | null;
	/** Revokes a thread's public link. False if it doesn't exist or wasn't shared. */
	unshareSession(sessionId: string): boolean;
	/** The read-only data served at the unauthenticated `/shared/:token`
	 * route. Null for an unknown/revoked token. */
	getSharedSession(
		token: string,
	): { title?: string; persona: string; model: string; messages: DisplayMessage[] } | null;
	/** Resolve the live, in-memory session owning `token`, so the public share
	 * route can relay its events read-only. Null when the session isn't
	 * running in this process (closed, or driven by another process). */
	getSharedLiveSession(token: string): WebAgentSession | null;
	submit(
		sessionId: string,
		text: string,
		images?: string[],
		clientMessageId?: string,
		queuedMessages?: Message[],
		opts?: { maxOuterIterations?: number },
	): Promise<void>;
	/** Inject a message into the running turn (submits; the loop's
	 *  steeringQueue drains it if a turn is in flight, matching /steer). */
	steer(sessionId: string, message: string): void;
	/** Queue a message to run after the current turn (matches /queue). */
	followUp(sessionId: string, message: string): void;
	/** Outstanding user questions, if the agent is waiting for choices. */
	getQuestion(sessionId: string): PlanQuestion | undefined;
	/** Records choices and resumes the same conversation in either mode. */
	answerQuestion(
		sessionId: string,
		values: Array<string | string[]>,
	): Promise<{ ok: true } | { ok: false; error: string }>;
	getPlanTransition(sessionId: string): { kind: "done" } | undefined;
	resolvePlanTransition(sessionId: string, kind: "done"): { ok: true } | { ok: false; error: string };
	/** Flip a session between plan/build mode. The TUI in daemon mode owns its
	 * mode locally but the daemon caches the session it hydrates — without an
	 * explicit sync the daemon would keep running the old mode. */
	setSessionMode(sessionId: string, mode: "plan" | "build"): { ok: true } | { ok: false; error: string };
	resetContext(sessionId: string): { ok: true; originalTask?: string } | { ok: false; error: string };
	abort(sessionId: string): void;
	subscribe(sessionId: string, callback: (event: WebEvent) => void): void;
	unsubscribe(sessionId: string, callback: (event: WebEvent) => void): void;
	/** Sidebar-wide event stream — fires for every session's session_update,
	 * not just the one this listener is scoped to. */
	subscribeAll(callback: (event: WebEvent) => void): void;
	unsubscribeAll(callback: (event: WebEvent) => void): void;
	/** Releases process-wide live-event subscriptions when the daemon shuts down. */
	dispose?(): void;
	executeCommand(sessionId: string, command: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
	/** Runs a settings-only command without requiring a visible chat session.
	 * This is intentionally separate from executeCommand so the TUI keeps its
	 * session-bound command path unchanged. */
	executeSettingsCommand(command: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
	getConfig(): {
		baseURL: string;
		model: string;
		persona: string;
		theme: string;
		cwd: string;
		quickSessionPersona: string;
	};
	getPersonas(): Array<{ name: string; label: string; description: string; source: string }>;
	getThemes(): Array<{ id: string; label: string; description: string; colors: ThemeColors }>;
	getModels(providerName?: string): Promise<{ models: ModelInfo[]; error?: string }>;
	/** Verify arbitrary provider credentials without saving (web UI gate). */
	verifyProvider(url: string, apiKey: string): Promise<{ ok: boolean; probe: string; error?: string }>;
	getCachedModels(): { models: ModelInfo[] };
	saveSshKey(name: string, keyContent: string): { ok: boolean; path?: string; error?: string };
	addSshHost(
		name: string,
		host: string,
		username: string | undefined,
		port: number | undefined,
		keyPath: string | undefined,
		password: string | undefined,
	): { ok: boolean; error?: string };
	readSkillContent(name: string): { ok: boolean; content?: string; error?: string };
	readPersonaContent(name: string): { ok: boolean; content?: string; error?: string };
	readPluginContent(pluginId: string): { ok: boolean; content?: string; error?: string };
	getReasoningOptionsForSession(sessionId: string): { options: Array<{ value: string; label: string }> };
	suggestCommand(sessionId: string, input: string): Array<{ value: string; label: string }>;
	getSlashCommands(sessionId?: string): typeof SLASH_COMMANDS;
}

export function createServerBridge(result: StartupResult): ServerBridge {
	const sessions = new Map<string, WebAgentSession>();
	// Tool-call start timestamps keyed by call id, so tool_end can record the
	// per-tool latency (tool_calls.latency_ms).
	const toolStartTimes = new Map<string, number>();
	const idleSessionEvictions = new Map<string, ReturnType<typeof setTimeout>>();
	const IDLE_SESSION_EVICTION_MS = 5 * 60_000;
	// Sidebar listeners, one per connected browser tab, independent of which
	// session (if any) that tab currently has open — this is what lets the
	// message-count badges for background/other threads update live instead
	// of only refreshing on a full page reload.
	const sessionListListeners = new Set<(event: WebEvent) => void>();
	const unsubscribeActorNotifications = subscribeAgentActorNotifications((actor) => {
		if (!actor.parentSessionId) return;
		const ws = sessions.get(actor.parentSessionId);
		if (!ws) return;
		broadcast(ws, { type: "agent_actor", actor });
	});

	const { config, cwd, persona: currentPersona, reasoningMeta: initialReasoningMeta, projectDeps } = result;
	let reasoningMeta = initialReasoningMeta;

	// Everything below is captured once at startup by the TUI's own
	// per-process App component, but the web bridge outlives many
	// sessions/requests — so /reload, /mcp, /skills, and /plugin (anything
	// that changes project-local resources) need these as *mutable* bridge
	// state, not `const`s from the initial destructure, plus a way to push a
	// change out to every live session's system prompt (see
	// recomputeAllSystemPrompts below), not just the one that issued the command.
	let mcpResult = result.mcpResult;
	let personas = result.personas;
	let subagentModel = result.subagentModel;
	let subagentModelProvider = result.subagentModelProvider;
	let planModel = result.planModel;
	let planModelProvider = result.planModelProvider;
	let projectTrusted = result.projectTrusted;
	const contextFilesSuffix = result.contextFilesSuffix;
	let rulesSuffix = result.rulesSuffix;
	let rulesLazySuffix = result.rulesLazySuffix;
	let directoryRules = result.directoryRules;
	let skills = result.skills;
	// SSH hosts and permission mode are simple settings-backed values with no
	// prompt-rebuild fan-out, but still need to be mutable so /ssh and
	// /permissions actually take effect without a server restart.
	let sshHosts = result.sshHosts;
	let permissionMode = result.permissionMode;
	const subPrompts = result.subagentPrompts;
	// The model a brand-new session should start on. Seeded from the very
	// first session built at startup, but /model updates it too — otherwise a
	// mid-run model switch never reached new sessions, which kept defaulting
	// to whatever was active when the server started.
	let defaultModel = result.session.model;
	// Persona the web UI's "Quick session" sidebar button uses — skips the
	// full persona picker. Read from settings.json at startup (not part of
	// StartupResult, which has no concept of this — it's a web-only
	// preference), same "read once into a mutable var, updateSettings on
	// change" shape as defaultModel above.
	let quickSessionPersona = loadSettings().quickSessionPersona ?? DEFAULT_PERSONA;

	/**
	 * Re-read settings.json and adopt any provider/model/reasoning change made
	 * from a *different* surface. The `cast server` daemon and the TUI are separate
	 * processes: a provider/model switch done in the TUI (or a manual settings
	 * edit) lands in settings.json but never reaches this daemon's shared
	 * `config`, which is captured once at startup and only updated by /provider
	 * and /model commands running *through this process*. A stale daemon then
	 * sends the freshly-picked model id to the old endpoint — 400 for a model
	 * that endpoint doesn't serve, 429 for one that's out of credits — and only
	 * a `cast server restart` used to fix it. Returns whether the active endpoint
	 * changed, so callers can reconcile in-flight session model ids against the
	 * new provider's model list.
	 */
	function syncActiveProviderFromSettings(): { endpointChanged: boolean } {
		const settings = loadSettings();
		// Follow every persisted slot, not only the active endpoint. TUI can run
		// with CAST_NO_DAEMON=1 while the web daemon stays alive, so cached slot
		// values must not be the authority across turns.
		if (settings.model !== undefined) defaultModel = settings.model;
		subagentModel = settings.subagentModel;
		subagentModelProvider = settings.subagentModelProvider;
		planModel = settings.planModel;
		planModelProvider = settings.planModelProvider;

		// providerUrl/apiKey are the active endpoint, and modelProvider names the
		// saved provider row that owns it. Both are persisted by every provider
		// switch so a daemon and the next startup resolve the same connection.
		const baseURL = settings.providerUrl;
		const apiKey = settings.apiKey;
		if (!baseURL || !apiKey) return { endpointChanged: false };

		const named = settings.modelProvider
			? (settings.providers ?? []).find((p) => p.name === settings.modelProvider)
			: undefined;
		const nextReasoningFormat = resolveReasoningFormat(baseURL, named?.reasoningFormat);
		const endpointChanged = baseURL !== config.baseURL || apiKey !== config.apiKey;
		const reasoningFormatChanged = nextReasoningFormat !== config.reasoningFormat;
		if (endpointChanged) {
			config.baseURL = baseURL;
			config.apiKey = apiKey;
			// The cached /v1/models list came from the old endpoint — clear it so
			// model pickers/completions can't offer ids the new endpoint lacks.
			setModelsCache([]);
		}
		if (reasoningFormatChanged) config.reasoningFormat = nextReasoningFormat;

		// Reasoning level is a global setting persisted by /reasoning in either
		// process — follow external edits too, not just local ones.
		if (settings.reasoningLevel !== undefined && settings.reasoningLevel !== config.reasoningLevel) {
			config.reasoningLevel = settings.reasoningLevel;
		}
		if (endpointChanged || reasoningFormatChanged || settings.reasoningLevel !== undefined) {
			config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, defaultModel);
		}

		return { endpointChanged };
	}

	function syncExternalSessionModel(ws: WebAgentSession): boolean {
		const stored = loadSessionMeta(ws.id);
		if (!stored || (stored.model === ws.session.model && stored.providerUrl === ws.session.providerUrl)) return false;

		ws.session.model = stored.model;
		ws.session.providerUrl = stored.providerUrl;
		ws.session.providerName = stored.providerName;
		ws.systemPrompt = computeSystemPrompt(
			resolvePersona(ws.session.persona ?? "") ?? currentPersona,
			ws.session.model,
			ws.session.cwd ?? cwd,
			ws.session.mode,
		);
		broadcastSessionUpdate(ws);
		return true;
	}

	/**
	 * The active endpoint changed between turns (external settings edit) and
	 * this session's model id was chosen against the old one — if the new
	 * provider doesn't serve it, the next request would 400. Check the new
	 * provider's /v1/models and fall back to the configured default model when
	 * the current id is missing. Models that exist on both endpoints are kept.
	 */
	async function reconcileSessionModel(ws: WebAgentSession): Promise<void> {
		const current = ws.session.model;
		const result = await fetchModels(config);
		if (!result.ok || !result.models) return;
		setModelsCache(result.models);
		if (result.models.some((m) => m.id === current)) return;
		if (!defaultModel || defaultModel === current) return;
		if (!result.models.some((m) => m.id === defaultModel)) return;

		ws.session.model = defaultModel;
		ws.systemPrompt = computeSystemPrompt(
			resolvePersona(ws.session.persona ?? "") ?? currentPersona,
			defaultModel,
			ws.session.cwd ?? cwd,
			ws.session.mode,
		);
		saveSession(ws.session);
		broadcast(ws, {
			type: "notice",
			message: `Active provider changed — model "${current}" isn't available there, this session switched to "${defaultModel}".`,
		});
		broadcastSessionUpdate(ws);
	}

	/**
	 * Same `buildSystemPrompt` core call the TUI's /persona and /model handlers
	 * use (src/ui/commands.ts `rebuildSystemPrompt`) — kept here as a direct
	 * call rather than a re-wrapped helper so this file doesn't grow its own
	 * copy of the assembly logic.
	 */
	function computeSystemPrompt(persona: Persona, model: string, sessionCwd: string, mode?: "plan" | "build"): string {
		// Formatted fresh from the raw `skills` array (rather than caching one
		// pre-formatted string for every persona) so a `skills:` restriction on
		// the active persona is reflected in what the model is told is
		// available — kept in sync with what loop.ts actually lets it call.
		const suffix = formatSkillsForPrompt(skills, persona.skills);
		return buildSystemPrompt(
			persona,
			contextFilesSuffix,
			rulesSuffix,
			rulesLazySuffix,
			suffix,
			formatMcpForPrompt(mcpResult, persona.mcp),
			sessionCwd,
			{ model, reasoningLevel: config.reasoningLevel, reasoningMeta, mode },
		);
	}

	function resolvePersona(name: string): Persona | undefined {
		return personas.find((p) => p.name === name);
	}

	/** Rebuilds every live session's system prompt from current bridge-level
	 * project state — needed after /reload, /mcp, or /skills, since those
	 * change resources shared by every session, not just the one that issued
	 * the command (unlike /model or /persona, which are already per-session). */
	function recomputeAllSystemPrompts(): void {
		for (const ws of sessions.values()) {
			const persona = resolvePersona(ws.session.persona ?? "") ?? currentPersona;
			ws.systemPrompt = computeSystemPrompt(persona, ws.session.model, ws.session.cwd ?? cwd, ws.session.mode);
		}
	}

	// `submit` (a hoisted function declared further down this closure) is only
	// ever *invoked* by onIdleWake later, asynchronously, once a background
	// task finishes — never called during construction — so referencing it
	// here before its textual definition is safe.
	function makeBackgroundBash(runner: AgentRunner, sessionId: string): BashBackgroundDeps {
		const registry = new BackgroundTaskRegistry();
		registry.setOnIdleWake((text) => submit(sessionId, text));
		return { registry, followUpQueue: runner.followUpQueue, isRunning: () => runner.isRunning };
	}

	function createSessionInstance(
		personaName?: string,
		modelOverride?: string,
		cwdOverride?: string,
		runSessionStartHook = true,
		worktree?: SessionWorktree,
		providerOverride?: string,
	): WebAgentSession {
		// New sessions must start on whatever provider/model settings.json
		// currently declares — not whatever was active when the daemon booted
		// (see syncActiveProviderFromSettings). Otherwise /new keeps producing
		// sessions on the stale startup provider even after an external switch.
		syncActiveProviderFromSettings();
		const persona = personaName ? (resolvePersona(personaName) ?? currentPersona) : currentPersona;
		const model = modelOverride ?? persona.model ?? defaultModel;
		const providerName = providerOverride ?? persona.provider;
		// Resolved eagerly (unlike the plan/subagent slots, which re-resolve
		// fresh per turn from mutable settings) — a session's pinned provider
		// is meant to survive later /provider switch calls, not track them.
		const pinnedProvider = providerName
			? (loadSettings().providers ?? []).find((p) => p.name === providerName)
			: undefined;

		let sessionCwd = cwdOverride && cwdOverride !== SANDBOX_CWD ? cwdOverride : cwd;
		// Worktree and sandbox are mutually exclusive — worktree wins if both
		// arrive. Sandbox is "throwaway scratch dir", worktree is "real
		// isolated working copy"; combining them would leave the sandbox
		// inside a worktree (or vice versa), which neither feature is
		// designed for. The HTTP layer rejects this combo up front so callers
		// see a clean 400; the defence here covers direct bridge callers
		// (e.g. /new slash command) that bypass validation.
		if (worktree) sessionCwd = worktree.path;
		const session = createSession(model, sessionCwd);
		session.persona = persona.name;
		session.providerUrl = pinnedProvider?.url ?? config.baseURL;
		session.providerName = pinnedProvider?.name;

		// Scratch dirs must exist before SessionStart hooks run: hooks receive this
		// cwd and are allowed to prepare the workspace. Web drafts don't reach this
		// code until their first real message, so this still avoids abandoned dirs.
		// Skipped when a worktree already pinned sessionCwd — the worktree is
		// git-managed and exists by the time we get here.
		if (cwdOverride === SANDBOX_CWD && !worktree) {
			sessionCwd = join(homedir(), ".cast", "sandbox", `cast-${session.id}`);
			session.cwd = sessionCwd;
			mkdirSync(sessionCwd, { recursive: true });
		}

		const runner = createAgentRunner();
		const ws: WebAgentSession = {
			id: session.id,
			session,
			runner,
			backgroundBash: makeBackgroundBash(runner, session.id),
			status: "idle",
			error: null,
			listeners: new Set(),
			acceptedClientMessageIds: new Set(),
			systemPrompt: computeSystemPrompt(persona, model, sessionCwd),
		};

		sessions.set(session.id, ws);
		if (runSessionStartHook) {
			// Fire-and-forget (SessionStart is non-blocking, matching Grok Build) —
			// this function is sync and callers don't need to wait on a hook script.
			void runHooksForEvent(resolveHooksForCwd(sessionCwd, projectTrusted), {
				event: "SessionStart",
				cwd: sessionCwd,
				sessionId: session.id,
				payload: { source: "startup" },
			});
		}
		// Start the idle cwd watcher — agent isn't running yet so it's safe.
		syncFsWatcher(ws);
		return ws;
	}

	// An attachment's absolute path (`~/.cast/inputs/<session-id>/...`) is
	// embedded as literal text in the message that referenced it (see
	// composer.js's <system-reminder>), not looked up by session id at read
	// time — forkSession's deep-copied history still points at the source
	// session's inputs dir. Left alone, deleting the source session later
	// (which rmSyncs that dir) leaves the fork's transcript referencing files
	// that no longer exist. Copy the dir under the fork's own id and rewrite
	// every occurrence of the old path so the fork is a real independent
	// snapshot, the same way its message history already is.
	function rehomeForkedAttachments(sourceSessionId: string, forked: SessionState): void {
		const sourceDir = sessionInputsDir(sourceSessionId);
		if (!existsSync(sourceDir)) return;
		const forkDir = sessionInputsDir(forked.id);
		cpSync(sourceDir, forkDir, { recursive: true });
		const rewrite = (value: unknown): unknown => {
			if (typeof value === "string") return value.includes(sourceDir) ? value.split(sourceDir).join(forkDir) : value;
			if (Array.isArray(value)) return value.map(rewrite);
			if (value && typeof value === "object")
				return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
			return value;
		};
		forked.messages = rewrite(forked.messages) as SessionState["messages"];
		saveSession(forked);
	}

	function forkSessionInstance(sessionId: string): WebAgentSession | undefined {
		const source = getSession(sessionId);
		if (!source || source.status === "running") return undefined;
		const session = forkSession(source.session);
		rehomeForkedAttachments(source.session.id, session);
		const persona = resolvePersona(session.persona ?? "") ?? currentPersona;
		const runner = createAgentRunner();
		const ws: WebAgentSession = {
			id: session.id,
			session,
			runner,
			backgroundBash: makeBackgroundBash(runner, session.id),
			status: "idle",
			error: null,
			listeners: new Set(),
			acceptedClientMessageIds: new Set(),
			systemPrompt: computeSystemPrompt(persona, session.model, session.cwd ?? cwd, session.mode),
		};
		sessions.set(session.id, ws);
		syncFsWatcher(ws);
		broadcastSessionUpdate(ws);
		return ws;
	}

	function broadcast(ws: WebAgentSession, event: WebEvent): void {
		for (const listener of ws.listeners) {
			try {
				listener(event);
			} catch {
				// Listener threw — remove it to avoid poisoning the set.
			}
		}
	}

	function persistDecisionState(
		ws: WebAgentSession,
		question: PlanQuestion | undefined,
		planTransition: { kind: "done" } | undefined,
	): void {
		ws.session.planQuestion = question;
		ws.session.planTransition = planTransition;
		saveSession(ws.session);
		broadcast(ws, { type: "decision_state", question, planTransition });
	}

	/** Pushes a sidebar-friendly snapshot so every connected client (including
	 *  tabs that didn't initiate the turn) can update their session list
	 *  without a full refetch. */
	function broadcastSessionUpdate(ws: WebAgentSession): void {
		try {
			const event: WebEvent = { type: "session_update", session: summaryFor(ws.session, ws.status) };
			broadcast(ws, event);
			for (const listener of sessionListListeners) {
				try {
					listener(event);
				} catch {
					// Listener threw — remove it to avoid poisoning the set.
				}
			}
		} catch {
			// Defensive: summaryFor reads session.messages.length — if the run
			// left messages in an unexpected state, don't crash the broadcast.
		}
	}

	/** Idle-period cwd watcher. Fires `fs_change` SSE events so the UI's
	 *  Changes tab and Files tree pick up edits that happened outside of an
	 *  agent turn (manual editor, CI hook, etc). Suspended while a turn runs so
	 *  it never races `tool_end`. */
	const fsWatchers = new Map<string, { close: () => unknown; on: (...args: unknown[]) => unknown }[]>();
	const fsDebounceTimers = new Map<string, NodeJS.Timeout>();
	const FS_DEBOUNCE_MS = 500;
	/** Debounce + broadcast handler shared by every recursive watcher. Looks
	 * the session up on every event so we always operate on the live ws — the
	 * Map entry is replaced by re-hydration under the same id (see the race in
	 * `hydrateSession`), and a captured `ws` reference would point at a stale
	 * object whose listeners set is empty. */
	function makeFsCallback(sessionId: string): (eventName: string, filePath: string) => void {
		return (eventName, filePath) => {
			const existing = fsDebounceTimers.get(sessionId);
			if (existing) clearTimeout(existing);
			fsDebounceTimers.set(
				sessionId,
				setTimeout(() => {
					fsDebounceTimers.delete(sessionId);
					const ws = sessions.get(sessionId);
					if (!ws || ws.status !== "idle") return;
					broadcast(ws, { type: "fs_change" });
					const hookEvent = eventName === "addDir" ? "DirectoryAdded" : "FileChanged";
					const hooks = resolveHooksForCwd(ws.session.cwd ?? cwd, projectTrusted);
					void runHooksForEvent(hooks, {
						event: hookEvent,
						cwd: ws.session.cwd ?? cwd,
						sessionId: ws.id,
						matchTarget: basename(filePath),
						payload: { file_path: filePath, file_name: basename(filePath), change_type: eventName },
					});
				}, FS_DEBOUNCE_MS),
			);
		};
	}
	function startFsWatcher(ws: WebAgentSession): void {
		if (fsWatchers.has(ws.id)) return;
		const sessionCwd = ws.session.cwd;
		if (!sessionCwd || !existsSync(sessionCwd)) return;
		try {
			// chokidar wraps native fs.watch with cross-platform polling and
			// a sane ignore matcher — no more inotify max_user_watches limit
			// on real cwds, no more top-level-only coverage. We exclude the
			// usual noise (.git, node_modules, build outputs) so an `npm i`
			// or git gc doesn't fire 100k events.
			//
			// chokidar v5's `string` matcher is a literal-equality check (it
			// does not expand globs), so we use a function predicate against
			// the absolute path of every event.
			const ignoreSegments = new Set([
				"node_modules",
				".git",
				"dist",
				"build",
				".next",
				".cache",
				"__pycache__",
				".venv",
				"venv",
				".tox",
				".mypy_cache",
			]);
			const watcher = chokidar.watch(sessionCwd, {
				ignored: (path) => path.split("/").some((p) => ignoreSegments.has(p)),
				ignoreInitial: true,
				persistent: true,
				awaitWriteFinish: false,
			});
			watcher.on("all", makeFsCallback(ws.id));
			watcher.on("error", () => {
				stopFsWatcher(ws.id);
			});
			fsWatchers.set(ws.id, [watcher as unknown as { close: () => unknown; on: (...args: unknown[]) => unknown }]);
		} catch {
			// cwd may not exist (e.g. sandbox removed); ignore silently.
		}
	}
	function stopFsWatcher(sessionId: string): void {
		const list = fsWatchers.get(sessionId);
		if (list) {
			for (const w of list) {
				try {
					// chokidar's close() returns a Promise — fire-and-forget is
					// fine here, the inotify wd releases on process exit anyway.
					const result = (w as unknown as { close: () => unknown }).close();
					if (result && typeof (result as Promise<unknown>).catch === "function") {
						(result as Promise<unknown>).catch(() => {});
					}
				} catch {
					// already closed by error handler
				}
			}
			fsWatchers.delete(sessionId);
		}
		const t = fsDebounceTimers.get(sessionId);
		if (t) {
			clearTimeout(t);
			fsDebounceTimers.delete(sessionId);
		}
	}

	function syncIdleSessionEviction(ws: WebAgentSession): void {
		const existing = idleSessionEvictions.get(ws.id);
		const canEvict = ws.status === "idle" && ws.listeners.size === 0 && !ws.backgroundBash.registry.hasRunning();
		if (!canEvict) {
			if (existing) clearTimeout(existing);
			idleSessionEvictions.delete(ws.id);
			return;
		}
		if (existing) return;
		const timer = setTimeout(() => {
			idleSessionEvictions.delete(ws.id);
			const live = sessions.get(ws.id);
			if (
				!live ||
				live !== ws ||
				live.status !== "idle" ||
				live.listeners.size > 0 ||
				live.backgroundBash.registry.hasRunning()
			) {
				return;
			}
			if (countTurnMessages(live.session.messages) > 0) saveSession(live.session);
			stopFsWatcher(live.id);
			sessions.delete(live.id);
		}, IDLE_SESSION_EVICTION_MS);
		timer.unref();
		idleSessionEvictions.set(ws.id, timer);
	}
	/** Toggles the idle watcher as the session enters/leaves a turn. */
	function syncFsWatcher(ws: WebAgentSession): void {
		const hooks = resolveHooksForCwd(ws.session.cwd ?? cwd, projectTrusted);
		const needsFileHooks = Boolean(hooks.FileChanged?.length || hooks.DirectoryAdded?.length);
		if (ws.status === "idle" && (ws.listeners.size > 0 || needsFileHooks)) startFsWatcher(ws);
		else stopFsWatcher(ws.id);
		syncIdleSessionEviction(ws);
	}

	/** Builds a real user turn's `content` — plain text when there are no
	 * images (matches every existing persisted message and the tests that
	 * assert on it), or a `[{type:"text"},...image_url]` array otherwise.
	 * Always includes the text part, even empty, when images are present —
	 * that's what session.ts's isRealTurnStart (compaction's safe-cut-point
	 * search) uses to tell a real turn from the tool-only image_url relay
	 * loop.ts inserts after a `read` on an image file, which never has one. */
	function buildUserContent(text: string, images?: string[]): string | Array<Record<string, unknown>> {
		if (!images || images.length === 0) return text;
		return [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
	}

	/** Observation-only, fire-and-forget — a skill/rule name expanding into its actual prompt content. */
	function fireUserPromptExpansion(sessionCwd: string, name: string): void {
		const hooks = resolveHooksForCwd(sessionCwd, projectTrusted);
		if (!hasHooks(hooks)) return;
		void runHooksForEvent(hooks, {
			event: "UserPromptExpansion",
			matchTarget: name,
			cwd: sessionCwd,
			payload: { command_name: name },
		});
	}

	function startQueuedFollowUps(sessionId: string, ws: WebAgentSession): void {
		const queued = ws.runner.followUpQueue.drain();
		if (queued.length === 0) return;
		const text = queued
			.map((message) => (typeof message.content === "string" ? message.content : ""))
			.filter(Boolean)
			.join("\n\n");
		broadcast(ws, { type: "followup_injected", messages: queued });
		void submit(sessionId, text, undefined, undefined, queued);
	}

	async function submit(
		sessionId: string,
		text: string,
		images?: string[],
		clientMessageId?: string,
		queuedMessages?: Message[],
		opts?: { maxOuterIterations?: number },
	): Promise<void> {
		const ws = sessions.get(sessionId);
		if (!ws) throw new Error("Session not found");
		if (clientMessageId) {
			if (ws.acceptedClientMessageIds.has(clientMessageId)) return;
			const alreadyPersisted = getFullHistory(ws.id).some(
				(message) =>
					(message as Message & { castClientMessageId?: string }).castClientMessageId === clientMessageId,
			);
			if (alreadyPersisted) {
				ws.acceptedClientMessageIds.add(clientMessageId);
				return;
			}
			// Claim the id NOW, synchronously, before the running-check and async
			// setup below. A thin-client reconnect re-send of the same message
			// arriving while this submit is still setting up must be deduped here,
			// or it falls through to the steering branch and injects a duplicate
			// user message into the running turn. failSetup removes the claim so
			// a genuinely failed send can be retried.
			ws.acceptedClientMessageIds.add(clientMessageId);
		}

		// A turn already running (e.g. the same session open in a second
		// browser tab that also just hit send) must not start a second,
		// concurrent runAgentLoop against the same ws.session — both would
		// race to reassign ws.session.messages and scramble/interleave the
		// persisted history. Mirrors the TUI's own submit() (useAgentSession.ts)
		// and this bridge's /steer command: steer into the running turn
		// instead. The loop drains steeringQueue and broadcasts
		// "steering_injected" itself, so every connected tab sees it land.
		if (ws.status === "running" || ws.runner.isRunning) {
			ws.runner.steeringQueue.enqueue({
				role: "user",
				content: buildUserContent(text, images),
				...(clientMessageId ? { castClientMessageId: clientMessageId } : {}),
			} as Message);
			if (clientMessageId) ws.acceptedClientMessageIds.add(clientMessageId);
			return;
		}
		// Claim synchronously before provider/session reconciliation can yield.
		// A second browser tab must steer immediately instead of starting a
		// second loop after the first async setup step completes.
		const ac = new AbortController();
		const lease = ws.runner.startRun(ac);
		const automaticMemoryMaintenance = ws.session.messages.length === 0;
		const automaticMemoryMessages = ws.session.messages.slice();
		ws.currentClientMessageId = clientMessageId;
		ws.status = "running";
		ws.error = null;
		ws.turnStartedAt = Date.now();
		syncFsWatcher(ws);
		broadcast(ws, { type: "status", status: "running", startedAt: ws.turnStartedAt });
		broadcastSessionUpdate(ws);
		let chk: ReturnType<typeof createCheckpoint>;
		const failSetup = (error: unknown): void => {
			ws.status = "error";
			ws.error = error instanceof Error ? error.message : String(error);
			ws.runner.abort();
			ws.runner.endRun(lease);
			ws.activeStream = undefined;
			ws.turnStartedAt = undefined;
			ws.currentClientMessageId = undefined;
			// Undo the early id claim so a retry of the same message can be
			// delivered on the next attempt (the message was never persisted).
			if (clientMessageId) ws.acceptedClientMessageIds.delete(clientMessageId);
			syncFsWatcher(ws);
			broadcast(ws, { type: "error", message: ws.error });
			broadcast(ws, { type: "status", status: "error" });
			broadcastSessionUpdate(ws);
		};
		// A provider/model switch made outside this daemon (the TUI process, or
		// a manual settings.json edit) must take effect on this turn — otherwise
		// the daemon keeps calling the endpoint it started on with the model the
		// user picked elsewhere (400 / 429 until a restart). Reconcile the
		// session's model id against the new provider when the endpoint moved.
		let endpointChanged: boolean;
		try {
			({ endpointChanged } = syncActiveProviderFromSettings());
			const sessionModelChanged = syncExternalSessionModel(ws);
			if (sessionModelChanged && !endpointChanged) {
				const refreshed = await fetchModels(config);
				if (refreshed.ok && refreshed.models) setModelsCache(refreshed.models);
			}
			if (sessionModelChanged) reasoningMeta = modelInfoFor(ws.session.model)?.reasoning;
			if (endpointChanged) await reconcileSessionModel(ws);
		} catch (error) {
			failSetup(error);
			return;
		}

		const sessionCwd = ws.session.cwd ?? cwd;
		// Persona files can be created or edited by the agent itself. Re-scan this
		// session's persona sources before every new turn so an override written in
		// the previous turn is effective without reconnecting MCP or restarting the
		// daemon. The active turn keeps the old tool set; only this next turn changes.
		const turnPersonas = resolvePersonasForCwd(sessionCwd, projectTrusted).personas;
		const submitHooks = resolveHooksForCwd(sessionCwd, projectTrusted);
		if (hasHooks(submitHooks)) {
			let submitResult: Awaited<ReturnType<typeof runHooksForEvent>>;
			try {
				submitResult = await runHooksForEvent(submitHooks, {
					event: "UserPromptSubmit",
					cwd: sessionCwd,
					sessionId: ws.session.id,
					payload: { prompt: text },
				});
			} catch (error) {
				failSetup(error);
				return;
			}
			if (submitResult.blocked) {
				ws.status = "idle";
				ws.turnStartedAt = undefined;
				ws.runner.abort();
				ws.runner.endRun(lease);
				syncFsWatcher(ws);
				broadcast(ws, { type: "status", status: "idle" });
				broadcastSessionUpdate(ws);
				broadcast(ws, {
					type: "error",
					message: `Prompt blocked by hook: ${submitResult.reason ?? "no reason given"}`,
				});
				return;
			}
			if (submitResult.reason) text = `${text}\n\n<hook-context>${submitResult.reason}</hook-context>`;
		}

		if (ws.session.cwd && !existsSync(ws.session.cwd)) {
			mkdirSync(ws.session.cwd, { recursive: true });
		}

		if (queuedMessages) {
			for (const message of queuedMessages) appendMessage(ws.session, message);
		} else {
			const userMsg = { role: "user" as const, content: buildUserContent(text, images) } as Message & {
				role: "user";
				castClientMessageId?: string;
			};
			if (clientMessageId) userMsg.castClientMessageId = clientMessageId;
			appendMessage(ws.session, userMsg);
		}
		const persona = turnPersonas.find((p) => p.name === ws.session.persona) ?? currentPersona;
		ws.systemPrompt = computeSystemPrompt(persona, ws.session.model, sessionCwd, ws.session.mode);

		// One `assistant_message` event fires per assistant completion this
		// turn, in the same order those completions get pushed onto `messages`
		// — collecting them here lets the `.then` below re-associate each
		// non-empty one with the assistant message it belongs to once the
		// final array (with real indices) comes back.
		const startCount = ws.session.messages.length;
		const thinkingByCompletion: string[] = [];
		ws.activeStream = [];
		let activeStreamCompletion = false;
		let activeStreamOrder = 0;
		// Save the session NOW — before the run starts — so the user's message
		// is persisted even if the process is killed mid-run (SIGTERM timeout,
		// OOM, crash). runAgentLoop works on a private copy of the array (see
		// its `const messages = [...initialMessages]`), so ws.session.messages
		// stays at the pre-run snapshot during the entire run. The `.then()`
		// below does the final authoritative save with assistant responses.
		saveSession(ws.session);
		if (!queuedMessages) {
			const userMsg = ws.session.messages[ws.session.messages.length - 1] as Message & {
				castClientMessageId?: string;
			};
			broadcast(ws, {
				type: "user_message",
				message: {
					role: "user",
					content: userMsg.content as string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
					...(userMsg.castClientMessageId ? { clientMessageId: userMsg.castClientMessageId } : {}),
				},
			});
		}

		// Workspace checkpoint for /undo — after saveSession above so the
		// session row already exists (session_checkpoints has an FK to it).
		chk = createCheckpoint(sessionCwd);
		if (!ws.session.checkpoints) ws.session.checkpoints = [];
		ws.session.checkpoints.push(chk);
		// Persist alongside the in-memory array (session.checkpoints isn't in
		// the session row — see session.ts) so /undo survives a daemon restart.
		appendCheckpoint(ws.session.id, chk);

		// Read fresh each run (not captured once) so a mid-session /web toggle
		// takes effect on the very next turn — matches core/run.ts's headless
		// path, which does the same loadSettings() call per turn rather than
		// caching it at startup.
		const planMode = ws.session.mode === "plan";
		const disabledTools = new Set<string>(modeDisabledTools(planMode));
		if (loadSettings().webTools !== true) {
			disabledTools.add("web_search");
			disabledTools.add("web_fetch");
		}
		const planState = createPlanState(ws.session.cwd ?? cwd, ws.session.id, {
			question: ws.session.planQuestion,
			transition: ws.session.planTransition,
			onChange: (question, transition) => {
				persistDecisionState(ws, question, transition);
			},
		});
		planState.enabled = planMode;
		// Plan mode can run under a separate, usually-cheaper model (matches the
		// TUI's App.tsx activeModel calc) — this only affects THIS run, session.model
		// itself is untouched so leaving plan mode reverts automatically.
		const runModel = planMode && planModel ? planModel : ws.session.model;

		// Resolve per-slot provider credentials.
		const currentSettings = loadSettings();
		const providers = currentSettings.providers ?? [];
		const globalActiveCreds = { baseURL: config.baseURL, apiKey: config.apiKey };
		// The main model's endpoint is THIS session's own recorded provider, not
		// necessarily whatever's globally active right now — `config` is one
		// object shared by the whole daemon, so resolving straight from it here
		// meant a /model-selection or /provider switch run inside any session
		// silently redirected every other already-open session's very next turn
		// to the same endpoint too. Sessions already record their own
		// providerUrl/providerName (set at creation, and on every
		// session-scoped model/provider change) — this just starts reading it
		// back for the run instead of only for display/resume-matching.
		// Matched by name first — providerUrl alone can't disambiguate two
		// saved providers that legitimately share a base URL with different
		// keys (confirmed live: routed a session to the wrong of two
		// same-host providers before this was name-first). URL-only is kept
		// as a fallback for sessions saved before providerName existed.
		// Falls back to whatever's globally active when unset (new-enough
		// default) or when the recorded name/URL no longer matches any saved
		// provider (renamed/deleted since).
		const sessionProvider = ws.session.providerName
			? providers.find((p) => p.name === ws.session.providerName)
			: ws.session.providerUrl
				? providers.find((p) => p.url === ws.session.providerUrl)
				: undefined;
		const activeCreds = sessionProvider
			? { baseURL: sessionProvider.url, apiKey: sessionProvider.apiKey }
			: globalActiveCreds;
		const resolvedModelProvider =
			planMode && planModel && planModelProvider
				? resolveProvider(providers, planModelProvider, activeCreds)
				: undefined;
		const resolvedSubagentProvider = resolveProvider(providers, subagentModelProvider, activeCreds);
		// Which provider actually served this run — shown under the reply so
		// the user knows what answered before deciding whether to /model away
		// from it. Matched by URL since that's the only thing a resolved
		// provider and a saved provider entry share.
		const turnStart = ws.turnStartedAt ?? Date.now();
		const effectiveBaseURL = resolvedModelProvider?.baseURL ?? activeCreds.baseURL;
		const effectiveApiKey = resolvedModelProvider?.apiKey ?? activeCreds.apiKey;
		// Match by url+key, not just url — two saved providers can legitimately
		// share a base URL (e.g. two keys against the same OpenAI-compatible
		// host), and URL-only matching would silently pick the first one.
		const effectiveProvider = providers.find((p) => p.url === effectiveBaseURL && p.apiKey === effectiveApiKey);
		const runReasoningFormat = resolveReasoningFormat(effectiveBaseURL, effectiveProvider?.reasoningFormat);
		const runReasoningLevel = reasoningLevelForModel(runModel, runReasoningFormat);
		const runConfig = {
			...config,
			baseURL: effectiveBaseURL,
			apiKey: effectiveApiKey,
			reasoningFormat: runReasoningFormat,
			reasoningLevel: runReasoningLevel,
			reasoningParams: buildReasoningParams(runReasoningLevel, runReasoningFormat, runModel),
		};
		// Only sync the shared config/settings when this run is actually using
		// the globally active provider — a session pinned to a different one
		// must not push its reasoning level onto every other session sharing
		// the global default.
		if (runModel === ws.session.model && !sessionProvider && runReasoningLevel !== config.reasoningLevel) {
			config.reasoningLevel = runReasoningLevel;
			config.reasoningFormat = runReasoningFormat;
			config.reasoningParams = runConfig.reasoningParams;
			updateSettings({ reasoningLevel: runReasoningLevel });
		}
		// Look the provider up by name (falls back to url+key for legacy state
		// where modelProvider wasn't saved). URL alone is ambiguous when two
		// providers share a base URL — would always pick the first one and
		// mislabel the chat footer.
		const runProviderName =
			providers.find((p) => p.url === effectiveBaseURL && p.apiKey === effectiveApiKey)?.name ?? "default";

		runAgentLoop(ws.session.messages, {
			config: runConfig,
			model: runModel,
			modelProvider: resolvedModelProvider,
			subagentModelProvider: resolvedSubagentProvider,
			cwd: ws.session.cwd ?? cwd,
			systemPrompt: ws.systemPrompt,
			memory: { sessionId: ws.session.id },
			automaticMemoryMaintenance,
			automaticMemoryMessages,
			signal: ac.signal,
			steeringQueue: ws.runner.steeringQueue,
			followUpQueue: ws.runner.followUpQueue,
			confirmBash: permissionMode === "bypass" ? undefined : async () => true,
			disabledTools,
			planState,
			initialTodos: ws.session.todos,
			mcpTools: mcpResult.toolDefinitions,
			mcpToolIndex: mcpResult.toolIndex,
			hooks: submitHooks,
			sessionId: ws.session.id,
			permissionMode,
			...(opts?.maxOuterIterations ? { maxOuterIterations: opts.maxOuterIterations } : {}),
			// Read fresh each submit so an edited maxTurnIterations applies on
			// the next agent call.
			defaultOuterIterations: turnIterationCap(),
			skills,
			personas: turnPersonas,
			currentPersona: persona.name,
			subagentPrompts: subPrompts,
			subagentModel,
			projectTrusted,
			sshHosts,
			backgroundBash: ws.backgroundBash,
			mcpPromptSuffix: formatMcpForPrompt(mcpResult, persona.mcp),
			beforeFileWrite: (path) => {
				backupFileForCheckpoint(chk, path);
				updateLastCheckpoint(ws.session.id, chk);
			},
			onCompaction: (full, compacted) => recordCompaction(ws.session, full, compacted),
			// Non-fatal warnings from the loop (e.g. "Model doesn't support
			// images — sending file path only") must reach the browser like any
			// other notice, or the vision fallback looks like a silent failure.
			onWarning: (message) => broadcast(ws, { type: "notice", message }),
			onMessagesChanged: (messages) => {
				ws.session.messages = messages;
				try {
					saveSession(ws.session);
				} catch {
					// Best-effort: disk full / permissions shouldn't kill the run.
				}
			},
			onEvent: (event: AgentEvent) => {
				// Persist execution telemetry for audit/debug — events that say
				// "what the engine did", not "what the user sees". token/thinking
				// are too fine-grained (thousands per turn) and their final form
				// already lands in messages; these are the coarse, useful ones.
				switch (event.type) {
					case "tool_start": {
						const ts = event as { id: string };
						toolStartTimes.set(ts.id, Date.now());
						appendSessionEvent(sessionId, event.type, event);
						break;
					}
					case "tool_end": {
						// One row per completed tool call (not per start+end) — the
						// end event carries the error flag, so recording only here
						// avoids double-counting usage.
						const t = event as { id: string; name: string; result: { isError?: boolean } };
						const started = toolStartTimes.get(t.id);
						toolStartTimes.delete(t.id);
						recordToolCall(
							ws.id,
							t.name,
							t.result?.isError === true,
							started !== undefined ? Date.now() - started : undefined,
							ws.currentClientMessageId,
						);
						appendSessionEvent(sessionId, event.type, event);
						break;
					}
					case "doom_loop": {
						const d = event as { tool: string; attempts: number };
						recordLlmRequest({
							sessionId: ws.id,
							provider: runProviderName,
							model: runModel,
							kind: "error",
							error: `doom loop: ${d.tool} x${d.attempts}`,
							errorType: "doom-loop",
							turnId: ws.currentClientMessageId,
						});
						appendSessionEvent(sessionId, event.type, event);
						break;
					}
					case "compaction": {
						const c = event as { messagesCompacted: number; tokensBefore: number };
						recordLlmCompaction(ws.id, c.messagesCompacted, c.tokensBefore);
						appendSessionEvent(sessionId, event.type, event);
						break;
					}
					case "turn_end":
					case "open_work_gate":
					case "open_work_gate_exhausted":
					case "retry":
					case "compaction_failed":
					case "interrupt_reminder":
					case "date_rollover":
					case "end":
					case "error":
						appendSessionEvent(sessionId, event.type, event);
						if (event.type === "retry") {
							recordLlmRequest({
								sessionId: ws.id,
								provider: runProviderName,
								model: runModel,
								kind: "retry",
								retries: event.attempt,
								error: event.reason,
								errorType: classifyLlmError(event.reason),
							});
						} else if (event.type === "error") {
							recordLlmRequest({
								sessionId: ws.id,
								provider: runProviderName,
								model: runModel,
								kind: "error",
								error: event.message,
								errorType: classifyLlmError(event.message),
							});
						}
						break;
					default:
						break;
				}
				if (event.type === "token" || event.type === "thinking") {
					if (activeStreamCompletion) {
						ws.activeStream = [];
						activeStreamCompletion = false;
					}
					ws.activeStream = appendActiveText(
						ws.activeStream,
						event.type === "token" ? "content" : "thinking",
						event.text,
						activeStreamOrder++,
					);
				}
				if (event.type === "tool_start") {
					activeStreamCompletion = false;
					ws.activeStream = [
						...(ws.activeStream ?? []),
						{
							order: activeStreamOrder++,
							kind: "tool",
							call: { id: event.id, name: event.name, args: event.args, status: event.status, result: "" },
						},
					];
				}
				if (event.type === "tool_end") {
					ws.activeStream = (ws.activeStream ?? []).map((block) =>
						block.kind === "tool" && block.call.id === event.id
							? {
									...block,
									call: {
										...block.call,
										status: event.status,
										result: event.result.content,
										...(event.result.imageDataUrl ? { images: [event.result.imageDataUrl] } : {}),
									},
								}
							: block,
					);
				}
				if (event.type === "assistant_message") {
					void runHooksForEvent(resolveHooksForCwd(ws.session.cwd ?? cwd, projectTrusted), {
						event: "MessageDisplay",
						cwd: ws.session.cwd ?? cwd,
						sessionId: ws.id,
						payload: { message: event.content, tool_calls: event.toolCalls },
					});
					// The loop commits this placeholder when a retried turn is
					// still empty — a real quality signal for the Reliability tab.
					if (event.content === "(no response)") {
						recordLlmRequest({
							sessionId: ws.id,
							provider: runProviderName,
							model: runModel,
							kind: "error",
							error: "empty response",
							errorType: "empty-response",
							turnId: ws.currentClientMessageId,
						});
					}
					thinkingByCompletion.push(event.thinking ?? "");
					ws.activeStream = [
						...(event.thinking
							? [{ order: activeStreamOrder++, kind: "thinking" as const, text: event.thinking }]
							: []),
						...(event.content
							? [{ order: activeStreamOrder++, kind: "content" as const, text: event.content }]
							: []),
					];
					activeStreamCompletion = true;
				}
				if (event.type === "todos_updated") ws.session.todos = event.todos;
				if (event.type === "usage") {
					addUsage(ws.session, event.usage, { subagent: event.subagent, background: event.background });
					// One row per LLM request — the loop emits this event exactly
					// once per completion (main / subagent aggregate / background /
					// compaction), so telemetry can't double-count. Cheap single
					// prepared INSERT on the event path.
					recordLlmRequest({
						sessionId: ws.id,
						provider: runProviderName,
						model: runModel,
						kind: event.background ? "background" : event.subagent ? "subagent" : "main",
						promptTokens: event.usage.promptTokens,
						completionTokens: event.usage.completionTokens,
						cacheReadTokens: event.usage.cacheReadTokens,
						cacheWriteTokens: event.usage.cacheWriteTokens,
						cost: event.usage.cost,
						latencyMs: event.generationMs,
						ttftMs: event.ttftMs,
						contextWindow: config.contextWindow,
						turnId: ws.currentClientMessageId,
					});
					if (event.background) {
						saveSession(ws.session);
						broadcastSessionUpdate(ws);
					}
					if (!event.subagent && !event.background) {
						ws.lastTurn = {
							generationMs: event.generationMs,
							tokensPerSecond:
								event.generationMs && event.usage.completionTokens
									? Math.round((event.usage.completionTokens / (event.generationMs / 1000)) * 10) / 10
									: undefined,
							completedAt: new Date().toISOString(),
							model: runModel,
							provider: runProviderName,
						};
					}
				}
				broadcast(ws, event);
			},
		})
			.then((finalMessages) => {
				// Final authoritative save — onMessagesChanged has been snapshotting
				// intermediate progress (tool calls, partial replies) throughout the
				// run, so a crash only loses at most one event's worth of data.
				// This save adds reasoning metadata that the intermediate snapshots
				// don't carry.
				ws.session.messages = finalMessages;

				// Zip collected reasoning back onto the assistant messages this turn
				// added, in order — skips non-assistant messages (user/tool) so
				// interleaved steering/tool-result entries don't throw off the count.
				let completionIndex = 0;
				for (let i = startCount; i < finalMessages.length; i++) {
					if (finalMessages[i]!.role !== "assistant") continue;
					const thinking = thinkingByCompletion[completionIndex++];
					if (thinking) {
						ws.session.reasoning ??= {};
						ws.session.reasoning[i] = thinking;
					}
				}

				ws.status = "idle";
				ws.activeStream = undefined;
				ws.runner.endRun(lease);
				syncFsWatcher(ws);
				if (ws.lastTurn) ws.lastTurn.totalMs = Date.now() - turnStart;
				// Persisted per-turn (unlike ws.lastTurn above, which is the same
				// data but ephemeral/in-memory-only) so every past reply in this
				// thread shows its own "provider · model · Ns" footer on reload,
				// not just whichever turn happened to be most recent. Attached to
				// the turn-ending assistant message specifically — the loop only
				// ever ends on one (tool-call rounds always continue), so this is
				// never a tool/user message.
				const turnEndIndex = finalMessages.length - 1;
				if (finalMessages[turnEndIndex]?.role === "assistant") {
					ws.session.turnMeta ??= {};
					ws.session.turnMeta[turnEndIndex] = {
						provider: runProviderName,
						model: runModel,
						totalMs: Date.now() - turnStart,
						generationMs: ws.lastTurn?.generationMs,
						tokensPerSecond: ws.lastTurn?.tokensPerSecond,
						completedAt: new Date().toISOString(),
					} satisfies TurnMeta;
				}
				saveSession(ws.session);
				ws.turnStartedAt = undefined;
				broadcast(ws, { type: "status", status: "idle" });
				broadcast(ws, {
					type: "turn_meta",
					model: runModel,
					provider: runProviderName,
					totalMs: Date.now() - turnStart,
				});
				broadcast(ws, {
					type: "session_end",
					usage: ws.session.usage,
					// NOT a user-facing counter — this is compared against the web
					// client's local message array length (app.js) to decide whether
					// SSE delivered every event or a reconnect-recovery refetch is
					// needed. The client appends one entry per raw "assistant_message"
					// event (including tool-call-only intermediates), so this has to
					// match that same per-completion granularity, not the turn count
					// shown elsewhere in the UI.
					messageCount: ws.session.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
				});
				broadcastSessionUpdate(ws);
				startQueuedFollowUps(sessionId, ws);
			})
			.catch((err: unknown) => {
				ws.status = "error";
				ws.error = err instanceof Error ? err.message : String(err);
				ws.runner.endRun(lease);
				ws.activeStream = undefined;
				saveSession(ws.session);
				ws.turnStartedAt = undefined;
				broadcast(ws, { type: "error", message: ws.error });
				broadcast(ws, { type: "status", status: "error" });
				broadcastSessionUpdate(ws);
			});
	}

	function compactTurnTranscript(messages: Message[]): string {
		// Last ~24 assistant/tool messages, newest last — enough to recognize a
		// procedure without shipping the whole turn.
		const tail = messages.filter((m) => m.role === "assistant" || m.role === "tool").slice(-24);
		return tail
			.map((m) => {
				const text = typeof m.content === "string" ? m.content : "";
				const calls =
					"tool_calls" in m && Array.isArray((m as { tool_calls?: unknown }).tool_calls) ? " [tool call]" : "";
				return `${m.role === "tool" ? "TOOL" : "AGENT"}:${text.slice(0, 600)}${calls}`;
			})
			.join("\n");
	}

	async function runCompactLlm(system: string, user: string, maxTokens: number): Promise<{ content: string } | null> {
		try {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 20_000);
			timer.unref();
			const resp = await streamAndCollect(
				createClient(config, undefined),
				defaultModel,
				[
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				[],
				maxTokens,
				ac.signal,
			);
			clearTimeout(timer);
			return resp;
		} catch {
			return null;
		}
	}

	function normalizeSkillName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9-_]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	/** Safe-name the skill and write its SKILL.md to the project's
	 *  `.cast/skills/<name>/`. Mirrors the project-level skill location the
	 *  `/skills` command and skill loader already use. */
	function writeSkillFile(sessionCwd: string, name: string, body: string): void {
		const dir = join(sessionCwd, ".cast", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `${body}\n`, "utf-8");
	}

	/** Ask the model to flesh out a full SKILL.md for a named procedure based
	 *  on the session transcript. Returns the body (with YAML frontmatter). */
	async function generateSkillBody(name: string, description: string, messages: Message[]): Promise<string | null> {
		const transcript = compactTurnTranscript(messages);
		const resp = await runCompactLlm(
			'Write a concise Agent-Skills-style SKILL.md for a reusable project procedure. YAML frontmatter: name (kebab-case), description (one sentence, "Use when …"). Then a short ordered list of steps. Keep it under 30 lines — every line is a recurring token cost once loaded. Output only the SKILL.md file contents.',
			`Skill name: ${name}\nSkill description: ${description}\n\nProcedure performed in the session:\n\n${transcript}`,
			800,
		);
		if (!resp) return null;
		let body = resp.content.replace(CODE_FENCE_OPEN_RE, "").replace(CODE_FENCE_CLOSE_RE, "").trim();
		if (!body) return null;
		// If the model already emitted YAML frontmatter, leave it as-is.
		if (!body.startsWith("---")) {
			body = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
		}
		return body;
	}

	/** /evolve: analyze the session + typical project tasks, propose reusable
	 *  skills, and (via the answer path) write the chosen ones. Returns a
	 *  multi-select question for the picker, or a notice if nothing reusable
	 *  was found. */
	async function evolveSkills(ws: WebAgentSession): Promise<{ ok: boolean; result?: string; error?: string }> {
		if (ws.status === "running") return { ok: false, error: "Agent running" };
		const transcript = compactTurnTranscript(ws.session.messages);
		if (transcript.trim().length === 0) return { ok: false, error: "Session is empty — nothing to evolve from." };
		const project = projectTypicalTasks(ws.session.cwd ?? cwd);
		const resp = await runCompactLlm(
			EVOLVE_SYSTEM_PROMPT,
			EVOLVE_PROMPT.replace("{{PROJECT}}", project).replace("{{TRANSCRIPT}}", transcript),
			800,
		);
		if (!resp) return { ok: false, error: "Could not analyze the session." };
		const suggestions = parseEvolveJson(resp.content)
			.map((s) => ({ ...s, name: normalizeSkillName(s.name) }))
			.filter((s) => s.name && !skillExistsAnywhere(ws.session.cwd ?? cwd, s.name));
		if (suggestions.length === 0) {
			return { ok: true, result: "No reusable project skills to create from this session." };
		}
		const confirm: PlanQuestion = {
			questions: [
				{
					question: "Which skills should I create for this project?",
					options: suggestions.map((s) => ({
						value: s.name,
						label: `/${s.name}`,
						description: s.description,
					})),
					multi: true,
				},
			],
		};
		persistDecisionState(ws, confirm, ws.session.planTransition);
		return { ok: true };
	}

	/** A short digest of this project's typical tasks, derived from existing
	 *  skills and rules, to ground /evolve's suggestions. Falls back to the
	 *  cwd name. */
	function projectTypicalTasks(sessionCwd: string): string {
		const roots = [
			join(homedir(), ".cast", "skills"),
			join(sessionCwd, ".cast", "skills"),
			join(sessionCwd, ".agents", "skills"),
		];
		const names: string[] = [];
		for (const root of roots) {
			if (!existsSync(root)) continue;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md"))) names.push(entry.name);
			}
		}
		return names.length > 0 ? names.join(", ") : basename(sessionCwd) || sessionCwd;
	}

	/** True if a skill with this name exists at any project/global location. */
	function skillExistsAnywhere(sessionCwd: string, name: string): boolean {
		const candidates = [
			join(homedir(), ".cast", "skills", name, "SKILL.md"),
			join(sessionCwd, ".cast", "skills", name, "SKILL.md"),
			join(sessionCwd, ".agents", "skills", name, "SKILL.md"),
		];
		return candidates.some((p) => existsSync(p));
	}

	function abort(sessionId: string): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.runner.abort();
	}

	function steer(sessionId: string, message: string): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		// submit() itself enqueues into steeringQueue when a turn is running —
		// this is the /steer path, so it must reach the running loop rather
		// than start a fresh one.
		void submit(sessionId, message);
	}

	function followUp(sessionId: string, message: string): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		if (ws.status !== "running") {
			// The TUI decides whether to call /followup from its last SSE status.
			// A queued request can arrive after the daemon has already gone idle;
			// leaving it on an idle queue would strand it forever.
			void submit(sessionId, message);
			return;
		}
		ws.runner.followUpQueue.enqueue({ role: "user", content: message });
		// The request can arrive after the loop's final queue drain but before
		// its completion handler observes the settled state. Waiting on the
		// runner makes the handoff independent of SSE/status timing.
		void ws.runner.waitForIdle().then(() => {
			if (ws.status !== "running") startQueuedFollowUps(sessionId, ws);
		});
	}

	function getQuestion(sessionId: string): PlanQuestion | undefined {
		const ws = sessions.get(sessionId);
		if (!ws) return undefined;
		return ws.session.planQuestion;
	}

	function getPlanTransition(sessionId: string): { kind: "done" } | undefined {
		const ws = sessions.get(sessionId);
		if (!ws) return undefined;
		return ws.session.planTransition;
	}

	function resolvePersistedPlanTransition(
		sessionId: string,
		kind: "done",
	): { ok: true } | { ok: false; error: string } {
		const ws = sessions.get(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };
		if (ws.status === "running") return { ok: false, error: "Agent running" };
		const planState = createPlanState(ws.session.cwd ?? cwd, ws.session.id, {
			question: ws.session.planQuestion,
			transition: ws.session.planTransition,
			onChange: (question, nextTransition) => {
				persistDecisionState(ws, question, nextTransition);
			},
		});
		const transition = ws.session.planTransition;
		if (!transition || transition.kind !== kind)
			return { ok: false, error: "No matching plan transition is awaiting a choice" };
		ws.session.todos = createPlanTodos(planState);
		resolvePlanTransition(planState);
		saveSession(ws.session);
		return { ok: true };
	}

	async function answerQuestion(
		sessionId: string,
		values: Array<string | string[]>,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const ws = sessions.get(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };
		if (ws.status === "running") return { ok: false, error: "Agent running" };

		const planState = createPlanState(ws.session.cwd ?? cwd, ws.session.id, {
			question: ws.session.planQuestion,
			transition: ws.session.planTransition,
			onChange: (nextQuestion, transition) => {
				persistDecisionState(ws, nextQuestion, transition);
			},
		});
		const question = ws.session.planQuestion;
		if (!question) return { ok: false, error: "No question is awaiting an answer" };
		if (values.length !== question.questions.length)
			return { ok: false, error: "An answer is required for every question" };

		// /evolve intercept: a multi-select "which skills to create?" question
		// that we offered. Each value is an array of chosen option values; write
		// the matching skill files in place instead of feeding a synthetic
		// "Question:/Answer:" turn back to the model.
		const isEvolveQuestion = question.questions.length === 1 && question.questions[0].multi === true;
		if (isEvolveQuestion) {
			const item = question.questions[0];
			const chosen = Array.isArray(values[0]) ? (values[0] as string[]) : [];
			resolvePlanQuestion(planState);
			// Each chosen skill gets its own generateSkillBody call (independent
			// LLM request) and its own file (writeSkillFile keys the path by
			// name) — no shared state between iterations, so these run
			// concurrently instead of waiting on each other one at a time.
			const createdResults = await Promise.all(
				chosen.map(async (value): Promise<string | null> => {
					const option = item.options.find((o) => o.value === value);
					if (!option) return null;
					const name = normalizeSkillName(option.value);
					if (!name) return null;
					const body = await generateSkillBody(name, option.description ?? "", ws.session.messages);
					if (!body) return null;
					writeSkillFile(ws.session.cwd ?? cwd, name, body);
					return name;
				}),
			);
			const created = createdResults.filter((name): name is string => name !== null);
			if (created.length > 0) {
				broadcast(ws, {
					type: "notice",
					message: `Created ${created.length} skill${created.length > 1 ? "s" : ""}: ${created.map((n) => `/${n}`).join(", ")}.`,
				});
			} else {
				broadcast(ws, { type: "notice", message: "No skills created." });
			}
			return { ok: true };
		}

		// Each value is either the `value` of one of the model's options (picked
		// from the picker) or an arbitrary string the user typed into the composer.
		// The latter is a legitimate "free-form" answer — the user explicitly chose
		// not to pick any of the options offered. We accept the raw value either
		// way and use the option's `label` for display when it matches, falling
		// back to the raw value when it doesn't.
		const rendered = question.questions.map((item, index) => {
			const v = values[index];
			if (Array.isArray(v)) {
				const labels = v
					.map((value) => item.options.find((option) => option.value === value)?.label ?? value)
					.join(", ");
				return `Question: ${item.question} Answer: ${labels}`;
			}
			const match = item.options.find((option) => option.value === v);
			const display = match?.label ?? v;
			return `Question: ${item.question} Answer: ${display}`;
		});

		resolvePlanQuestion(planState);
		void submit(sessionId, rendered.join("\n"));
		return { ok: true };
	}

	function setSessionMode(sessionId: string, mode: "plan" | "build"): { ok: true } | { ok: false; error: string } {
		const ws = getSession(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };
		if (ws.status === "running") return { ok: false, error: "Agent running" };
		if (ws.session.mode === mode) return { ok: true };
		ws.session.mode = mode;
		// Mode is baked into the per-session system prompt (the plan-mode tool
		// block) — rebuild it so the next turn advertises the right surface.
		ws.systemPrompt = computeSystemPrompt(
			resolvePersona(ws.session.persona ?? "") ?? currentPersona,
			ws.session.model,
			ws.session.cwd ?? cwd,
			mode,
		);
		saveSession(ws.session);
		broadcastSessionUpdate(ws);
		return { ok: true };
	}

	function resetContext(sessionId: string): { ok: true; originalTask?: string } | { ok: false; error: string } {
		const ws = sessions.get(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };
		if (ws.status === "running") return { ok: false, error: "Agent running" };
		const originalTask = resetSessionContext(ws.session);
		saveSession(ws.session);
		return { ok: true, ...(originalTask ? { originalTask } : {}) };
	}

	function closeSession(sessionId: string, reason?: "shutdown"): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		if (ws.status === "running") ws.runner.abort(reason);
		ws.backgroundBash.registry.killAll();
		// A session with no real turns yet (freshly created — e.g. a persona
		// picked in the sidebar — then closed or dropped on shutdown without
		// ever sending a message) shouldn't leave a "0 msg" row behind forever.
		// A session only ever reaches disk via submit()'s saveSession call,
		// which never runs before the first message is appended, so a hydrated
		// (already-on-disk) session always has turns here too.
		if (countTurnMessages(ws.session.messages) > 0) {
			saveSession(ws.session);
		}
		void runHooksForEvent(resolveHooksForCwd(ws.session.cwd ?? cwd, projectTrusted), {
			event: "SessionEnd",
			cwd: ws.session.cwd ?? cwd,
			sessionId: ws.session.id,
			payload: { reason: reason ?? "closed" },
		});
		// Told before removal, and before clearing listeners, so any open SSE
		// connection gets one last frame to close itself on (see server.ts).
		broadcast(ws, { type: "session_closed" });
		ws.listeners.clear();
		const eviction = idleSessionEvictions.get(sessionId);
		if (eviction) clearTimeout(eviction);
		idleSessionEvictions.delete(sessionId);
		sessions.delete(sessionId);
		return true;
	}

	function deleteSessionPermanently(sessionId: string): boolean {
		const ws = sessions.get(sessionId);
		// Capture the cwd before the row is deleted — a session's throwaway
		// sandbox folder is cleaned up on delete, a user-chosen directory is
		// never touched. For a session already unloaded from memory (closed in
		// an earlier process run), load it from disk first.
		const sessionCwd = ws?.session.cwd ?? loadSession(sessionId)?.cwd;
		if (ws) {
			if (ws.status === "running") ws.runner.abort();
			ws.backgroundBash.registry.killAll();
			stopFsWatcher(sessionId);
			// No saveSession here — it's about to be deleted from disk anyway.
			broadcast(ws, { type: "session_closed" });
			ws.listeners.clear();
			sessions.delete(sessionId);
		}
		const eviction = idleSessionEvictions.get(sessionId);
		if (eviction) clearTimeout(eviction);
		idleSessionEvictions.delete(sessionId);
		// Also remove from disk regardless of whether it was live — a session
		// closed earlier in this process (or one from a previous run) only
		// exists on disk, and deleteSession() is what actually makes "Delete"
		// mean delete instead of just closeSession's "unload from memory".
		// deleteSession also removes the session's own throwaway sandbox folder
		// when cwd is exactly that folder (see core/session.ts).
		const removedFromDisk = deleteSession(sessionId, sessionCwd);
		// Attached documents live outside the session's own cwd (see
		// inputs.ts) specifically so they're never a project file the user has
		// to manage — that only holds if deleting the session also deletes
		// them. force:true since a session that never had any attachments is
		// the common case, not an error.
		rmSync(sessionInputsDir(sessionId), { recursive: true, force: true });
		return Boolean(ws) || removedFromDisk;
	}

	function subscribe(sessionId: string, callback: (event: WebEvent) => void): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.listeners.add(callback);
		syncFsWatcher(ws);
	}

	function unsubscribe(sessionId: string, callback: (event: WebEvent) => void): void {
		const ws = sessions.get(sessionId);
		if (!ws) return;
		ws.listeners.delete(callback);
		syncFsWatcher(ws);
	}

	function subscribeAll(callback: (event: WebEvent) => void): void {
		sessionListListeners.add(callback);
	}

	function unsubscribeAll(callback: (event: WebEvent) => void): void {
		sessionListListeners.delete(callback);
	}

	/**
	 * Sessions only live in this Map once something in this process instance
	 * has touched them — a fresh `cast server` restart starts with an empty Map
	 * even though every prior session is still sitting on disk (autosaved,
	 * same as the TUI). This lazily loads one of those cold sessions into a
	 * real, fully-interactive WebAgentSession the first time anything asks
	 * for it by id — after which it behaves exactly like one created this
	 * process's lifetime (same Map entry, same runner).
	 */
	function hydrateSession(id: string): WebAgentSession | undefined {
		const session = loadSession(id);
		if (!session) return undefined;
		// Two concurrent GETs for the same session id would otherwise race past
		// the existence check, each create a fresh `ws`, and the later .set
		// would clobber the earlier one — leaving the first request's listeners
		// and the second's listeners both stranded. Return the live entry on a
		// race so the caller (and its SSE listener registration) hits the same
		// object the next call will return.
		const existing = sessions.get(session.id);
		if (existing) return existing;
		const persona = resolvePersona(session.persona ?? "") ?? currentPersona;
		const runner = createAgentRunner();
		const ws: WebAgentSession = {
			id: session.id,
			session,
			runner,
			backgroundBash: makeBackgroundBash(runner, session.id),
			status: "idle",
			error: null,
			listeners: new Set(),
			acceptedClientMessageIds: new Set(),
			systemPrompt: computeSystemPrompt(persona, session.model, session.cwd ?? cwd, session.mode),
		};
		sessions.set(session.id, ws);
		void runHooksForEvent(resolveHooksForCwd(session.cwd ?? cwd, projectTrusted), {
			event: "SessionStart",
			cwd: session.cwd ?? cwd,
			sessionId: session.id,
			payload: { source: "resume" },
		});
		// Resumed sessions skip createSessionInstance — start the idle watcher
		// here too so the diff refreshes on external edits, not just on tool_end.
		syncFsWatcher(ws);
		return ws;
	}

	function getSession(id: string): WebAgentSession | undefined {
		return sessions.get(id) ?? hydrateSession(id);
	}

	function summaryFor(session: SessionState, status: WebAgentStatus): SessionSummary {
		return {
			id: session.id,
			persona: session.persona ?? currentPersona.name,
			model: session.model,
			cwd: session.cwd ?? cwd,
			title: session.title,
			pinned: session.pinned,
			status,
			isSandbox: (session.cwd ?? cwd) === join(homedir(), ".cast", "sandbox", `cast-${session.id}`),
			messageCount: countTurnMessages(session.messages),
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		};
	}

	function coldSummary(cold: CoreSessionSummary): SessionSummary {
		return {
			id: cold.id,
			persona: cold.persona ?? DEFAULT_PERSONA,
			model: cold.model ?? "",
			cwd: cold.cwd ?? cwd,
			title: cold.title,
			pinned: cold.pinned,
			// For a session not in our in-memory `sessions` map — i.e. driven by
			// another process (the TUI) — we rely on the per-session sentinel file
			// written by the loop's try/finally. Filtered by pid-alive + TTL in
			// turn-runner-state.ts, so a crashed runner self-heals even without
			// the unlink ever running.
			status: effectiveStatusFromFile(cold.id),
			isSandbox: (cold.cwd ?? cwd) === join(homedir(), ".cast", "sandbox", `cast-${cold.id}`),
			messageCount: cold.msgCount,
			createdAt: cold.createdAt ?? cold.updatedAt,
			updatedAt: cold.updatedAt,
		};
	}

	function listSessions(): SessionSummary[] {
		const out: SessionSummary[] = [];
		const seen = new Set<string>();
		for (const ws of sessions.values()) {
			out.push(summaryFor(ws.session, ws.status));
			seen.add(ws.id);
		}
		// Every other session that's ever been saved to disk (any project,
		// any prior process) — cold, not yet hydrated into a live runner, but
		// still a real thread the user should be able to find and reopen.
		for (const cold of listSessionSummaries()) {
			if (seen.has(cold.id)) continue;
			out.push(coldSummary(cold));
		}
		return out;
	}

	/** Same live/cold split as listSessions, but ranked by relevance against
	 *  `query` using the SQLite FTS index (core/session.ts's
	 *  searchSessionSummaries) instead of shipping every session's full
	 *  message text to the browser for client-side scoring. Safe to trust the
	 *  DB even for a session mutated moments ago — every mutation path in this
	 *  file calls saveSession() synchronously right after touching in-memory
	 *  state, so there's no meaningful window where the index is stale. */
	function searchSessions(query: string): SessionSummary[] {
		if (!query.trim()) return listSessions();
		return searchSessionSummaries(query).map((cold) => {
			const live = sessions.get(cold.id);
			return live ? summaryFor(live.session, live.status) : coldSummary(cold);
		});
	}

	function applyMcpResult(result: McpSetupResult): void {
		mcpResult = result;
	}

	/** Splits "sub rest of args" into its first word and everything after —
	 * used by every command with sub-verbs (/mcp enable <name>, /plugin
	 * marketplace add <src>, ...) since the outer name/arg split in
	 * executeCommand only peels off the top-level command name. */
	function splitArg(s: string): [string, string] {
		const i = s.indexOf(" ");
		return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1).trim()];
	}

	/** Same fallback chain the TUI's /reasoning uses: the meta captured at
	 * startup only matches the model cast launched with — a session that's
	 * since switched models (`/model`) falls back to whatever the provider's
	 * model list cache says about the model it's actually running now. */
	function reasoningOptionsFor(model: string): Array<{ value: string; label: string }> {
		const cached = getModelsCache().find((m) => m.id === model);
		const meta = cached?.reasoning ?? (model === result.session.model ? reasoningMeta : undefined);
		return getReasoningOptionsForFormat(meta ?? null, config.reasoningFormat, model, cached?.reasoningSupported);
	}

	function modelInfoFor(model: string): ModelInfo | undefined {
		const cached = getModelsCache().find((entry) => entry.id === model);
		if (cached) return cached;
		if (model === result.session.model && reasoningMeta) return { id: model, reasoning: reasoningMeta };
		return undefined;
	}

	function reasoningLevelForModel(model: string, format = config.reasoningFormat): string {
		const info = modelInfoFor(model);
		const options = getReasoningOptionsForFormat(info?.reasoning ?? null, format, model, info?.reasoningSupported);
		if (options.length === 0 || options.some((option) => option.value === config.reasoningLevel)) {
			return config.reasoningLevel;
		}
		return getDefaultReasoningLevel(info?.reasoning ?? null, format, model, info?.reasoningSupported);
	}

	function renameSession(sessionId: string, title: string): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		ws.session.title = title.trim().slice(0, 200);
		saveSession(ws.session);
		return true;
	}

	function pinSession(sessionId: string, pinned: boolean): boolean {
		const ws = sessions.get(sessionId);
		if (!ws) return false;
		ws.session.pinned = pinned || undefined;
		saveSession(ws.session);
		return true;
	}

	/** Generates (or returns the existing) public read-only link for this
	 * thread. Idempotent — calling it twice doesn't invalidate a link already
	 * handed out. Uses `getSession` (not the bare in-memory map) so a thread
	 * from before the last server restart can still be shared. */
	function shareSession(sessionId: string): { token: string } | null {
		const ws = getSession(sessionId);
		if (!ws) return null;
		if (!ws.session.shareToken) {
			ws.session.shareToken = randomBytes(24).toString("base64url");
			saveSession(ws.session);
		}
		return { token: ws.session.shareToken };
	}

	/** Revokes a thread's public link, if it has one — the old token
	 * immediately stops resolving. Returns false if the session doesn't exist
	 * or was never shared. */
	function unshareSession(sessionId: string): boolean {
		const ws = getSession(sessionId);
		if (!ws || !ws.session.shareToken) return false;
		ws.session.shareToken = undefined;
		saveSession(ws.session);
		return true;
	}

	/** The read-only projection served (with no auth at all) at
	 * `/shared/:token`. Deliberately narrow — no cwd, no persona system
	 * prompt, no tool internals beyond what toDisplayMessages already shows
	 * for the authenticated view; just enough to read the conversation. */
	function getSharedSession(
		token: string,
	): { title?: string; persona: string; model: string; messages: DisplayMessage[] } | null {
		const session = loadSessionByShareToken(token);
		if (!session) return null;
		return {
			title: session.title,
			persona: resolvePersona(session.persona ?? "")?.label ?? currentPersona.label,
			model: session.model,
			// Drop system messages (the persona's full system prompt, compaction
			// markers) — the authenticated view shows these to the session's own
			// owner, but a public link's anonymous visitor has no business
			// reading the persona's internal instructions, tool descriptions, or
			// project paths baked into it.
			// No sessionId/seqs passed: the image-blob route needs the same auth
			// as the rest of /api/sessions, but this view is deliberately
			// unauthenticated — inline data: URLs here instead (this is a public
			// link's read view, not the main session load the multi-MB-payload
			// problem is about).
			messages: toDisplayMessages(session.messages, session.reasoning, session.turnMeta).filter(
				(m) => m.role !== "system",
			),
		};
	}

	function getSharedLiveSession(token: string): WebAgentSession | null {
		for (const ws of sessions.values()) {
			if (ws.session.shareToken === token) return ws;
		}
		return null;
	}

	async function executeCommand(
		sessionId: string,
		command: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const ws = sessions.get(sessionId);
		if (!ws) return { ok: false, error: "Session not found" };
		const cmd = command.trim();
		if (!cmd.startsWith("/")) return { ok: false, error: "Not a command" };

		const spaceIdx = cmd.indexOf(" ");
		const name = spaceIdx === -1 ? cmd : cmd.slice(0, spaceIdx);
		const arg = spaceIdx === -1 ? "" : cmd.slice(spaceIdx + 1).trim();
		const running = ws.status === "running";

		// isCommandBlocking is the single source of truth for which commands
		// require idle (shared with the /api/commands list the client uses to
		// grey out the palette) — reject early instead of duplicating the set.
		if (running && isCommandBlocking(cmd)) {
			return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
		}

		// Non-blocking commands — work while the agent is running. Mirrors
		// src/ui/commands.ts's /steer and /queue semantics (see there): with
		// nothing running, both just submit the message as a normal turn.
		if (name === "/help") {
			return { ok: true, result: getHelpText() };
		}
		if (name === "/fork") {
			const fork = forkSessionInstance(sessionId);
			if (!fork) return { ok: false, error: "Could not fork session" };
			return { ok: true, result: { sessionId: fork.id } };
		}
		if (name === "/plan-note") {
			if (!arg) return { ok: false, error: "Usage: /plan-note <decision>" };
			const content = `<system-reminder>${arg}</system-reminder>`;
			appendMessage(ws.session, { role: "user", content });
			saveSession(ws.session);
			broadcast(ws, { type: "plan_decision", content: arg });
			broadcastSessionUpdate(ws);
			return { ok: true, result: "Recorded" };
		}
		if (name === "/current") {
			return {
				ok: true,
				result: {
					persona: ws.session.persona,
					model: ws.session.model,
					providerUrl: ws.session.providerUrl ?? config.baseURL,
					// Session's own pin by name first (disambiguates two saved
					// providers sharing a URL) — falls back to matching the
					// globally active provider for a session that isn't pinned.
					providerName:
						ws.session.providerName ??
						(loadSettings().providers ?? []).find(
							(provider) => provider.url === config.baseURL && provider.apiKey === config.apiKey,
						)?.name ??
						null,
					// Reasoning level is stored on the global `config` object, not the
					// session — the Settings → Model tab header reads this so the
					// user can see what level is currently in effect.
					reasoningLevel: config.reasoningLevel,
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
		}
		if (name === "/usage") {
			return { ok: true, result: ws.session.usage };
		}
		if (name === "/repo") {
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
			// 'git worktree list --porcelain' prints the worktree's absolute
			// path on the first line of each block, followed by 'HEAD <sha>'
			// and 'branch <name>'. We use it to detect whether the session
			// is running inside a worktree (rather than the main checkout)
			// so the StatusPopover can label it explicitly. Runs against the
			// main repo because 'git worktree list' is only valid there; we
			// resolve the main repo from the current cwd via --git-common-dir.
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
				// `git worktree list` shows the main checkout as the first
				// entry. We only call out a worktree path when the session's
				// cwd is in a separate entry — running inside the main
				// checkout itself is the common case and just shows "—".
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
				// git worktree list is best-effort; if it fails (e.g. the
				// session lives in a standalone clone without worktrees
				// registered) we just leave worktree = null and the UI
				// shows the em-dash placeholder.
			}
			return {
				ok: true,
				result: { cwd: sessionCwd, isGit: true, branch, dirty, worktree },
			};
		}
		if (name === "/goal") {
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
		}
		if (name === "/review") {
			// /review is blocking (isCommandBlocking), so this only runs idle.
			// Start the review turn without awaiting it — the SSE stream carries			// the agent's work; the command just acknowledges the kick-off.
			void submit(ws.id, REVIEW_PROMPT).catch((error) => {
				console.error(`[cast server] /review submit failed:`, error);
			});
			return { ok: true, result: "Reviewing the session's work…" };
		}
		if (name === "/turn-cap") {
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
		}
		if (name === "/evolve") {
			return await evolveSkills(ws);
		}
		if (name === "/rules") {
			return {
				ok: true,
				result: directoryRules.map((r) => ({
					id: r.id,
					name: r.name,
					description: r.description,
					applyMode: r.applyMode,
				})),
			};
		}
		if (name.startsWith("/rule:")) {
			const ruleId = name.slice("/rule:".length);
			if (!ruleId) return { ok: false, error: "Usage: /rule:<name>" };
			// Submits the rule body as a real user turn (matches the TUI's
			// agent.submit(formatRuleInvocation(rule)) — it's not a silent system-
			// prompt injection), so it needs the same idle gate a plain message
			// submit would get if the composer weren't already disabled while running.
			if (running) return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
			const rule = directoryRules.find((r) => r.id === ruleId) ?? directoryRules.find((r) => r.name === ruleId);
			if (!rule) return { ok: false, error: `Unknown rule: ${ruleId}. See /rules for the list.` };
			fireUserPromptExpansion(ws.session.cwd ?? cwd, rule.name);
			submit(sessionId, formatRuleInvocation(rule));
			return { ok: true, result: `Invoked rule: ${rule.name}` };
		}
		if (name === "/permissions") {
			// Global, like /reasoning and /web — `permissionMode` is bridge-level
			// mutable state read fresh by submit() on the next run.
			if (!arg) return { ok: true, result: { permissionMode } };
			if (arg !== "default" && arg !== "bypass") return { ok: false, error: "Usage: /permissions default|bypass" };
			permissionMode = arg;
			updateSettings({ permissionMode: arg });
			return { ok: true, result: { permissionMode: arg } };
		}
		if (name === "/web") {
			// A global setting (matches the TUI/`cast run`'s own /web and
			// core/run.ts) — takes effect on the NEXT turn in every session, since
			// submit() reads `loadSettings().webTools` fresh each run rather than
			// caching it, same as headless mode does.
			if (!arg) return { ok: true, result: { webTools: loadSettings().webTools === true } };
			if (arg !== "on" && arg !== "off") return { ok: false, error: "Usage: /web on|off" };
			updateSettings({ webTools: arg === "on" });
			return { ok: true, result: { webTools: arg === "on" } };
		}
		if (name === "/memory") {
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
				const memoryWriteEnabled = writeMatch[1]
					? writeMatch[1] === "on"
					: !(settings.memoryWriteEnabled !== false);
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
				const checkpointFork = checkpointForkMatch[1] === "on";
				updateSettings({ checkpointFork });
				return { ok: true, result: { checkpointFork } };
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
				const update =
					autoToggleMatch[1] === "dream" ? { memoryDreamAuto: enabled } : { memoryDistillAuto: enabled };
				updateSettings(update);
				return { ok: true, result: update };
			}
			const autoIntervalMatch = arg.match(MEMORY_AUTO_INTERVAL_COMMAND_RE);
			if (autoIntervalMatch) {
				const days = Math.max(0, Math.min(Number(autoIntervalMatch[2]), 3_650));
				const update =
					autoIntervalMatch[1] === "dream"
						? { memoryDreamIntervalDays: days }
						: { memoryDistillIntervalDays: days };
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
		}
		if (name === "/dream" || name === "/distill") {
			if (loadSettings().memoryEnabled === false) return { ok: false, error: "Project memory is disabled" };
			if (loadSettings().memoryWriteEnabled === false)
				return { ok: false, error: "Project memory writing is disabled" };
			try {
				const input = {
					cwd: ws.session.cwd ?? cwd,
					sessionId: ws.session.id,
					model: ws.session.model,
					config,
					messages: ws.session.messages,
					runAgent: runMemoryMaintenanceAgent,
				};
				if (name === "/dream") {
					const result = await dreamProjectMemory(input);
					return { ok: true, result: { removed: result.removed, stored: result.stored } };
				}
				const result = await distillProjectMemory(input);
				return { ok: true, result: { artifacts: result.artifacts } };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (name === "/web-search-provider") {
			// Same fresh-read pattern as /web — the next web_search call picks
			// this up via loadSettings() inside execWebSearch, no restart needed.
			if (!arg) {
				const s = loadSettings();
				return {
					ok: true,
					result: {
						searchProvider: s.searchProvider ?? "ddg",
						tavilyApiKey: s.tavilyApiKey,
						braveApiKey: s.braveApiKey,
					},
				};
			}
			const [provider, ...rest] = arg.split(" ");
			if (provider === "ddg") {
				updateSettings({ searchProvider: "ddg" });
				return { ok: true, result: { searchProvider: "ddg" } };
			}
			if (provider === "tavily") {
				const key = rest.join(" ").trim() || loadSettings().tavilyApiKey;
				if (!key) return { ok: false, error: "Usage: /web-search-provider tavily <api-key>" };
				updateSettings({ searchProvider: "tavily", tavilyApiKey: key });
				return { ok: true, result: { searchProvider: "tavily", tavilyApiKey: key } };
			}
			if (provider === "brave") {
				const key = rest.join(" ").trim() || loadSettings().braveApiKey;
				if (!key) return { ok: false, error: "Usage: /web-search-provider brave <api-key>" };
				updateSettings({ searchProvider: "brave", braveApiKey: key });
				return { ok: true, result: { searchProvider: "brave", braveApiKey: key } };
			}
			return { ok: false, error: "Usage: /web-search-provider ddg | tavily <api-key> | brave <api-key>" };
		}
		if (name === "/web-fetch-provider") {
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
		}
		if (name === "/theme") {
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
		}
		if (name === "/abort" || name === "/stop") {
			abort(sessionId);
			return { ok: true, result: "Aborted" };
		}
		if (name === "/sessions") {
			return { ok: true, result: listSessions() };
		}
		if (name === "/steer" || name === "/s") {
			if (!arg) return { ok: false, error: "Usage: /steer <message> — injects it into the running turn" };
			if (!running) {
				submit(sessionId, arg);
				return { ok: true, result: "Sent" };
			}
			ws.runner.steeringQueue.enqueue({ role: "user", content: arg });
			return { ok: true, result: "Steered into the running turn" };
		}
		if (name === "/queue" || name === "/q") {
			if (!arg) return { ok: false, error: "Usage: /queue <message> — runs after the current turn" };
			if (!running) {
				submit(sessionId, arg);
				return { ok: true, result: "Sent" };
			}
			ws.runner.followUpQueue.enqueue({ role: "user", content: arg });
			return { ok: true, result: "Queued for after this turn" };
		}
		if (name === "/queue-reset" || name === "/qr") {
			ws.runner.followUpQueue.clear();
			return { ok: true, result: "Queue cleared" };
		}

		if (name === "/hooks") {
			const sessionCwd = ws.session.cwd ?? cwd;
			const [verb, ...rest] = arg.split(WHITESPACE_SPLIT).filter(Boolean);
			if (verb === "help") {
				return {
					ok: true,
					result: "/hooks · /hooks enable <id> · /hooks disable <id> — see docs/hooks.md",
				};
			}
			const { entries, diagnostics } = listHooksForCwdSettings(sessionCwd, projectTrusted);
			if (!verb) {
				return { ok: true, result: { entries, diagnostics } };
			}
			if (verb === "enable" || verb === "disable") {
				const id = rest.join(" ").trim();
				if (!id) return { ok: false, error: `Usage: /hooks ${verb} <id>` };
				if (!entries.some((e) => e.id === id)) return { ok: false, error: `No hook with id "${id}"` };
				const settings = loadSettings();
				const disabled = new Set(settings.disabledHooks ?? []);
				if (verb === "disable") disabled.add(id);
				else disabled.delete(id);
				updateSettings({ disabledHooks: [...disabled] });
				return { ok: true, result: `Hook ${id} ${verb}d` };
			}
			return { ok: false, error: `Unknown /hooks ${verb}` };
		}

		// Everything below requires idle (enforced by the isCommandBlocking gate above).
		if (name === "/clear") {
			clearSessionMessages(ws.session);
			saveSession(ws.session);
			return { ok: true, result: "Context cleared" };
		}
		if (name === "/compact") {
			if (ws.session.messages.length === 0) return { ok: true, result: "Nothing to compact yet" };
			const compactHooks = resolveHooksForCwd(ws.session.cwd ?? cwd, projectTrusted);
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
			broadcast(ws, { type: "status", status: "running" });
			compactSessionMessages(ws.session.messages, config, ws.session.model, undefined, undefined, (usage) =>
				addUsage(ws.session, usage),
			)
				.then((result) => {
					ws.status = "idle";
					syncFsWatcher(ws);
					if (result.compacted) {
						recordCompaction(ws.session, ws.session.messages, result.messages);
						ws.session.messages = result.messages;
						broadcast(ws, {
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
						broadcast(ws, { type: "error", message: `Compaction failed: ${result.error}` });
					}
					saveSession(ws.session);
					broadcast(ws, { type: "status", status: "idle" });
				})
				.catch((err: unknown) => {
					ws.status = "error";
					ws.error = err instanceof Error ? err.message : String(err);
					broadcast(ws, { type: "error", message: ws.error });
					broadcast(ws, { type: "status", status: "error" });
				});
			return { ok: true, result: "Compacting…" };
		}
		if (name === "/new") {
			const newWs = await createSessionInstance(ws.session.persona ?? undefined, undefined, ws.session.cwd);
			return { ok: true, result: { sessionId: newWs.id } };
		}
		if (name === "/model-selection") {
			const [providerName, model] = arg.split(WHITESPACE_SPLIT).filter(Boolean);
			if (!providerName || !model) return { ok: false, error: "Usage: /model-selection <provider> <model>" };
			const provider = (loadSettings().providers ?? []).find((p) => p.name === providerName);
			if (!provider) return { ok: false, error: `Unknown provider: ${providerName}` };
			const target = { ...config, baseURL: provider.url, apiKey: provider.apiKey };
			const models = await fetchModels(target);
			if (!models.ok || !models.models?.some((entry) => entry.id === model)) {
				return {
					ok: false,
					error: models.error ?? `Model "${model}" is not available from provider "${providerName}"`,
				};
			}

			const providerChanged = config.baseURL !== provider.url || config.apiKey !== provider.apiKey;
			config.baseURL = provider.url;
			config.apiKey = provider.apiKey;
			config.reasoningFormat = resolveReasoningFormat(provider.url, provider.reasoningFormat);
			setModelsCache(models.models);
			const selected = models.models.find((entry) => entry.id === model);
			reasoningMeta = selected?.reasoning;
			config.reasoningLevel = reasoningLevelForModel(model, config.reasoningFormat);
			config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, model);
			ws.session.model = model;
			ws.session.providerUrl = provider.url;
			ws.session.providerName = provider.name;
			ws.systemPrompt = computeSystemPrompt(
				resolvePersona(ws.session.persona ?? "") ?? currentPersona,
				model,
				ws.session.cwd ?? cwd,
				ws.session.mode,
			);
			defaultModel = model;
			if (providerChanged && !subagentModelProvider) subagentModel = undefined;
			if (providerChanged && !planModelProvider) planModel = undefined;
			updateSettings({
				providerUrl: provider.url,
				apiKey: provider.apiKey,
				modelProvider: provider.name,
				model,
				reasoningLevel: config.reasoningLevel,
				...(providerChanged && !subagentModelProvider ? { subagentModel: undefined } : {}),
				...(providerChanged && !planModelProvider ? { planModel: undefined } : {}),
			});
			saveSession(ws.session);
			broadcastSessionUpdate(ws);
			return { ok: true, result: { model, provider: provider.name } };
		}
		if (name === "/model") {
			if (!arg) return { ok: true, result: { model: ws.session.model } };
			ws.session.model = arg;
			ws.session.providerUrl = config.baseURL;
			// Not resolved against a specific saved provider — this switches the
			// model on whatever's currently active, so any provider pin this
			// session had is no longer meaningful and must not be trusted stale.
			ws.session.providerName = undefined;
			reasoningMeta = modelInfoFor(arg)?.reasoning;
			config.reasoningLevel = reasoningLevelForModel(arg, config.reasoningFormat);
			config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, arg);
			ws.systemPrompt = computeSystemPrompt(
				resolvePersona(ws.session.persona ?? "") ?? currentPersona,
				arg,
				ws.session.cwd ?? cwd,
				ws.session.mode,
			);
			saveSession(ws.session);
			// Persist as the default for future sessions too — otherwise a model
			// switch only ever applied to the session it was issued on, and every
			// new session kept starting on whatever was active when the server
			// started (confirmed: switching M2 -> M3 then /new still opened M2).
			defaultModel = arg;
			updateSettings({ model: arg, reasoningLevel: config.reasoningLevel });
			// Sidebar footer reads the model off the session-list summary, not the
			// open session's live state — without this it kept showing the old
			// model until the turn ended (which resends it) or the page reloaded.
			broadcastSessionUpdate(ws);
			return { ok: true, result: { model: arg } };
		}
		if (name === "/reasoning") {
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
		}
		if (name === "/persona") {
			if (!arg) return { ok: true, result: { persona: ws.session.persona } };
			const persona = resolvePersona(arg);
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
		}
		if (name === "/quick-session-persona") {
			if (!arg) return { ok: true, result: { quickSessionPersona } };
			const persona = resolvePersona(arg);
			if (!persona) {
				return {
					ok: false,
					error: `Unknown persona: ${arg}. Available: ${personas.map((p) => p.name).join(", ")}`,
				};
			}
			quickSessionPersona = persona.name;
			updateSettings({ quickSessionPersona: persona.name });
			return { ok: true, result: { quickSessionPersona: persona.name } };
		}
		if (name === "/subagent-model") {
			if (!arg) return { ok: true, result: { subagentModel: subagentModel ?? null } };
			if (arg === "off" || arg === "reset") {
				subagentModel = undefined;
				if (arg === "reset") subagentModelProvider = undefined;
				updateSettings({
					subagentModel: undefined,
					...(arg === "reset" ? { subagentModelProvider: undefined } : {}),
				});
				return {
					ok: true,
					result: {
						subagentModel: null,
						...(arg === "reset" ? { subagentModelProvider: null } : {}),
					},
				};
			}
			subagentModel = arg;
			updateSettings({ subagentModel: arg });
			return { ok: true, result: { subagentModel: arg } };
		}
		if (name === "/subagent-model-provider") {
			if (!arg) return { ok: true, result: { subagentModelProvider: subagentModelProvider ?? null } };
			if (arg === "off" || arg === "reset") {
				subagentModelProvider = undefined;
				updateSettings({ subagentModelProvider: undefined });
				return { ok: true, result: { subagentModelProvider: null } };
			}
			subagentModelProvider = arg;
			updateSettings({ subagentModelProvider: arg });
			return { ok: true, result: { subagentModelProvider: arg } };
		}
		if (name === "/plan-model") {
			if (!arg) return { ok: true, result: { planModel: planModel ?? null } };
			if (arg === "off" || arg === "reset") {
				planModel = undefined;
				if (arg === "reset") planModelProvider = undefined;
				updateSettings({
					planModel: undefined,
					...(arg === "reset" ? { planModelProvider: undefined } : {}),
				});
				return {
					ok: true,
					result: { planModel: null, ...(arg === "reset" ? { planModelProvider: null } : {}) },
				};
			}
			planModel = arg;
			updateSettings({ planModel: arg });
			return { ok: true, result: { planModel: arg } };
		}
		if (name === "/plan-model-provider") {
			if (!arg) return { ok: true, result: { planModelProvider: planModelProvider ?? null } };
			if (arg === "off" || arg === "reset") {
				planModelProvider = undefined;
				updateSettings({ planModelProvider: undefined });
				return { ok: true, result: { planModelProvider: null } };
			}
			planModelProvider = arg;
			updateSettings({ planModelProvider: arg });
			return { ok: true, result: { planModelProvider: arg } };
		}
		if (name === "/plan" || name === "/build") {
			const mode = name === "/plan" ? "plan" : "build";
			ws.session.mode = mode;
			ws.systemPrompt = computeSystemPrompt(
				resolvePersona(ws.session.persona ?? "") ?? currentPersona,
				ws.session.model,
				ws.session.cwd ?? cwd,
				mode,
			);
			saveSession(ws.session);
			return {
				ok: true,
				result:
					mode === "plan"
						? "Plan mode — read-only exploration and planning; /build to exit"
						: "Build mode — full toolset",
			};
		}
		if (name === "/continue") {
			const others = listSessions()
				.filter((s) => s.id !== sessionId)
				.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			if (others.length === 0) return { ok: false, error: "No other sessions to continue" };
			return { ok: true, result: { sessionId: others[0]!.id } };
		}
		if (name === "/reload") {
			const sessionCwd = ws.session.cwd ?? cwd;
			try {
				projectTrusted = await resolveProjectTrustForCwd(projectDeps, sessionCwd);
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skills = skillsResult.skills;
				const rules = resolveRulesForCwd(sessionCwd, projectTrusted);
				rulesSuffix = rules.alwaysApplySuffix;
				rulesLazySuffix = rules.lazySuffix;
				directoryRules = rules.directoryRules;
				personas = resolvePersonasForCwd(sessionCwd, projectTrusted).personas;
				// Only reconnect MCP if the config actually changed on disk.
				const prevNames = mcpResult.allServerNames.slice().sort().join(",");
				const disabledMcp = loadSettings().disabledMcpServers ?? [];
				const freshMcp = await resolveMcpForCwd(
					projectDeps,
					sessionCwd,
					projectTrusted,
					disabledMcp,
					/*skipConnect=*/ true,
				);
				const newNames = freshMcp.allServerNames.slice().sort().join(",");
				if (prevNames !== newNames) {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(projectDeps, sessionCwd, projectTrusted, disabledMcp);
				}
				recomputeAllSystemPrompts();
				return { ok: true, result: "Reloaded skills, rules, MCP, and personas" };
			} catch (err) {
				return { ok: false, error: `Reload failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		if (name === "/mcp") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			if (!sub || sub === "list") {
				return {
					ok: true,
					result: mcpResult.allServerNames.map((n) => ({
						name: n,
						source: mcpResult.serverSources[n] ?? "global",
						connected: mcpResult.connections.some((c) => c.serverName === n),
						disabled: (loadSettings().disabledMcpServers ?? []).includes(n),
					})),
				};
			}
			if (sub === "help") {
				return {
					ok: true,
					result:
						"/mcp list · /mcp enable <name> · /mcp disable <name> · /mcp reconnect <name> · /mcp uninstall <name>",
				};
			}
			if (sub === "reconnect") {
				if (!rest) return { ok: false, error: "Usage: /mcp reconnect <name>" };
				if (!mcpResult.allServerNames.includes(rest)) return { ok: false, error: `Unknown MCP server: ${rest}` };
				try {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(
						projectDeps,
						sessionCwd,
						projectTrusted,
						loadSettings().disabledMcpServers ?? [],
					);
					recomputeAllSystemPrompts();
					const connected = mcpResult.connections.some((c) => c.serverName === rest);
					return { ok: true, result: `MCP server "${rest}" ${connected ? "reconnected" : "reconnect failed"}` };
				} catch (err) {
					return { ok: false, error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			if (sub === "enable" || sub === "disable") {
				if (!rest) return { ok: false, error: `Usage: /mcp ${sub} <name>` };
				const settings = loadSettings();
				const disabled = new Set(settings.disabledMcpServers ?? []);
				if (sub === "disable") disabled.add(rest);
				else disabled.delete(rest);
				updateSettings({ disabledMcpServers: [...disabled] });
				try {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(projectDeps, sessionCwd, projectTrusted, [...disabled]);
					recomputeAllSystemPrompts();
					return { ok: true, result: `MCP server "${rest}" ${sub}d` };
				} catch (err) {
					return { ok: false, error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			if (sub === "uninstall") {
				if (!rest) return { ok: false, error: "Usage: /mcp uninstall <name>" };
				const removed = removeMcpServerFromDisk(rest, sessionCwd, projectTrusted);
				if (!removed) return { ok: false, error: `Unknown or already-removed MCP server: ${rest}` };
				try {
					await closeMcpConnections(mcpResult.connections);
					mcpResult = await resolveMcpForCwd(
						projectDeps,
						sessionCwd,
						projectTrusted,
						loadSettings().disabledMcpServers ?? [],
					);
					recomputeAllSystemPrompts();
					return { ok: true, result: `Uninstalled MCP server "${rest}" (${removed.origin})` };
				} catch (err) {
					return { ok: false, error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			return { ok: false, error: `Unknown /mcp subcommand: ${sub}` };
		}
		if (name === "/skills") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			if (!sub || sub === "list") {
				const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				const disabled = new Set(loadSettings().disabledSkills ?? []);
				// `npx skills add` installs flat (`~/.agents/skills/<name>/SKILL.md`,
				// no repo-named subdirectory), so the source repo can only come
				// from its lockfile, keyed by skill name — never from the path.
				const skillsShSources = readSkillsShSources();
				return {
					ok: true,
					result: discovered.map((s) => {
						const skillsShSource = s.source === "agents" ? skillsShSources[s.name] : undefined;
						return {
							name: s.name,
							source: s.source,
							filePath: s.filePath,
							pluginId: s.pluginId,
							description: s.description,
							enabled: !disabled.has(s.name) && s.pluginEnabled !== false,
							uninstallable: isUninstallableSkill(s),
							// Agent directories are shared with other tools (Amp, Codex,
							// etc.). Only Skills.sh's lockfile establishes its provenance.
							skillssh: skillsShSource !== undefined,
							skillsshSource: skillsShSource,
						};
					}),
				};
			}
			if (sub === "help") {
				return {
					ok: true,
					result: "/skills list · /skills enable <name> · /skills disable <name> · /skills uninstall <name>",
				};
			}
			if (sub === "enable" || sub === "disable") {
				if (!rest) return { ok: false, error: `Usage: /skills ${sub} <name>` };
				const settings = loadSettings();
				const disabled = new Set(settings.disabledSkills ?? []);
				if (sub === "disable") disabled.add(rest);
				else disabled.delete(rest);
				updateSettings({ disabledSkills: [...disabled] });
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skills = skillsResult.skills;
				recomputeAllSystemPrompts();
				return { ok: true, result: `Skill "${rest}" ${sub}d` };
			}
			if (sub === "uninstall") {
				if (!rest) return { ok: false, error: "Usage: /skills uninstall <name>" };
				const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				const skill = discovered.find((s) => s.name === rest);
				if (!skill) return { ok: false, error: `Unknown skill: ${rest}` };
				if (!isUninstallableSkill(skill))
					return { ok: false, error: `"${rest}" isn't a removable skill (builtin/plugin)` };
				uninstallUserSkill(skill);
				const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
				skills = skillsResult.skills;
				recomputeAllSystemPrompts();
				return { ok: true, result: `Uninstalled skill "${rest}"` };
			}
			return { ok: false, error: `Unknown /skills subcommand: ${sub}` };
		}
		if (name === "/skills-sh") {
			const sessionCwd = ws.session.cwd ?? cwd;
			const [sub, ...restParts] = arg ? arg.split(WHITESPACE_SPLIT) : [""];
			const rest = restParts.join(" ");
			try {
				if (sub === "install") {
					if (!rest) return { ok: false, error: "Usage: /skills-sh install <owner/repo> --skill <name>" };
					// skills.sh's own "copy install command" button gives the full
					// `npx skills add <pkg> --skill <name>` line, not just the tail —
					// tolerate that being pasted in whole by dropping a leading
					// `npx [--yes|-y] skills [add|a]` prefix before parsing.
					const rawArgs = rest.split(WHITESPACE_SPLIT);
					// `npx skills add` accepts `https://github.com/<owner>/<repo>`
					// as the package argument, but our UI / `runSkillsSh` wrapper
					// hands the string off to the underlying CLI verbatim, which
					// expects `owner/repo` (or `owner/repo.git`). Strip a leading
					// github.com/ so the same paste "works" no matter where the
					// user copied the URL from — the original skills.sh site
					// copy-button uses the long form, which currently surfaces
					// as a confusing usage error.
					if (rawArgs[0] && GITHUB_URL_RE.test(rawArgs[0])) {
						rawArgs[0] = rawArgs[0].replace(GITHUB_URL_RE, "");
						rawArgs[0] = rawArgs[0].replace(GITHUB_GIT_SUFFIX, "");
					}
					if (rawArgs[0] === "npx") rawArgs.shift();
					if (rawArgs[0] === "--yes" || rawArgs[0] === "-y") rawArgs.shift();
					if (rawArgs[0] === "skills") rawArgs.shift();
					if (rawArgs[0] === "add" || rawArgs[0] === "a") rawArgs.shift();
					if (rawArgs.length === 0)
						return { ok: false, error: "Usage: /skills-sh install <owner/repo> --skill <name>" };
					// Drop any `-a`/`--agent` the caller passed and force `-g`/`--global`:
					// `skills add` with `-a <agent>` installs (only) into that agent's own
					// dir (e.g. `.claude/skills/`), never the universal `~/.agents/skills/`
					// tree Cast actually scans (see agentsGlobalSkillsDirs in project.ts) —
					// an `-a claude-code` install would silently never show up in Cast.
					// Omitting `-a` makes `add` install the universal copy and symlink it
					// into every agent dir it detects, so nothing is lost either way.
					const installArgs: string[] = [];
					for (let i = 0; i < rawArgs.length; i++) {
						const a = rawArgs[i];
						if (a === "-a" || a === "--agent") {
							i++; // skip its value too
							continue;
						}
						if (a !== "-g" && a !== "--global") installArgs.push(a);
					}
					installArgs.push("-g");
					const out = await runSkillsSh(["add", ...installArgs], 120_000);
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skills = skillsResult.skills;
					recomputeAllSystemPrompts();
					return { ok: true, result: out || "Installed." };
				}
				if (sub === "list-available") {
					if (!rest) return { ok: false, error: "Usage: /skills-sh list-available <owner/repo>" };
					return { ok: true, result: await runSkillsSh(["add", rest, "--list"], 60_000) };
				}
				if (sub === "search") {
					if (!rest) return { ok: false, error: "Usage: /skills-sh search <query>" };
					return { ok: true, result: await runSkillsSh(["find", ...rest.split(WHITESPACE_SPLIT)], 60_000) };
				}
				if (sub === "uninstall") {
					if (!rest) return { ok: false, error: "Usage: /skills-sh uninstall <name>" };
					// Cast installs Skills.sh entries into the universal scope. Without
					// --global, the CLI only searches the current project and reports a
					// successful no-op for skills such as ~/.config/agents/skills/pr-review.
					const out = await runSkillsSh(["remove", "--global", "--yes", ...rest.split(WHITESPACE_SPLIT)], 30_000);
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skills = skillsResult.skills;
					recomputeAllSystemPrompts();
					return { ok: true, result: out || "Uninstalled." };
				}
				return {
					ok: false,
					error: `Unknown /skills-sh subcommand: "${sub}". Try: install, list-available, search, uninstall.`,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		}
		if (name === "/plugin") {
			const [sub, rest] = splitArg(arg);
			const sessionCwd = ws.session.cwd ?? cwd;
			const settings = loadSettings();
			// Default Codex/Claude/Grok catalogs are seeded lazily — only for
			// subcommands that consume a marketplace (install resolves
			// `name@codex|claude|grok`, marketplace add registers one). The
			// read-only list/catalog paths must NOT seed: the very first seed
			// clones three repos through *synchronous* git (runGit uses
			// execFileSync) and would block the event loop for the whole
			// clone, stalling every concurrent request — including the Settings
			// modal's parallel /memory preload, which calls `/plugin marketplace
			// list` + `/plugin marketplace catalog` on open.
			const [marketplaceSubsub] = sub === "marketplace" ? splitArg(rest) : [undefined];
			const shouldSeedDefaults =
				sub === "install" ||
				(sub === "marketplace" &&
					marketplaceSubsub !== undefined &&
					marketplaceSubsub !== "list" &&
					marketplaceSubsub !== "catalog");
			if (shouldSeedDefaults) void ensureDefaultMarketplaces();
			try {
				if (!sub || sub === "list") {
					return { ok: true, result: listInstalledPlugins(settings) };
				}
				if (sub === "help") {
					return {
						ok: true,
						result:
							"/plugin list · /plugin install <name@marketplace> · /plugin uninstall <name@marketplace> · " +
							"/plugin enable/disable <name@marketplace> · /plugin marketplace add/list/remove/update",
					};
				}
				if (sub === "install") {
					if (!rest) return { ok: false, error: "Usage: /plugin install <name@marketplace>" };
					const r = await installPlugin(rest, settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skills = skillsResult.skills;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Installed plugin "${r.id}"` };
				}
				if (sub === "uninstall") {
					if (!rest) return { ok: false, error: "Usage: /plugin uninstall <name@marketplace>" };
					const r = uninstallPlugin(rest, settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skills = skillsResult.skills;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Uninstalled plugin "${r.id}"` };
				}
				if (sub === "enable" || sub === "disable") {
					if (!rest) return { ok: false, error: `Usage: /plugin ${sub} <name@marketplace>` };
					const r = setPluginEnabled(rest, sub === "enable", settings);
					updateSettings({ enabledPlugins: r.enabledPlugins });
					const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
					skills = skillsResult.skills;
					recomputeAllSystemPrompts();
					return { ok: true, result: `Plugin "${r.id}" ${sub}d` };
				}
				if (sub === "marketplace") {
					const [subsub, rest2] = splitArg(rest);
					if (!subsub || subsub === "list") {
						if (rest2) return { ok: true, result: getMarketplaceCatalog(rest2).plugins };
						return { ok: true, result: listKnownMarketplaces() };
					}
					if (subsub === "catalog") {
						const mps = listKnownMarketplaces();
						const results = [];
						for (const mp of mps) {
							try {
								const cat = getMarketplaceCatalog(mp.name);
								results.push({ name: mp.name, source: mp.source, plugins: cat.plugins });
							} catch {
								results.push({ name: mp.name, source: mp.source, plugins: [], error: true });
							}
						}
						return { ok: true, result: results };
					}
					if (subsub === "add") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace add <owner/repo|url|path>" };
						const mp = await addMarketplace(rest2);
						return { ok: true, result: `Added marketplace "${mp.name}"` };
					}
					if (subsub === "remove") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace remove <name>" };
						const removedIds = removeMarketplace(rest2);
						if (removedIds.length > 0) {
							const enabled = { ...(settings.enabledPlugins ?? {}) };
							for (const id of removedIds) delete enabled[id];
							updateSettings({ enabledPlugins: enabled });
							const skillsResult = await resolveSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
							skills = skillsResult.skills;
							recomputeAllSystemPrompts();
						}
						return { ok: true, result: `Removed marketplace "${rest2}"` };
					}
					if (subsub === "update") {
						if (!rest2) return { ok: false, error: "Usage: /plugin marketplace update <name>" };
						const mp = await updateMarketplace(rest2);
						return { ok: true, result: `Updated marketplace "${mp.name}"` };
					}
					return { ok: false, error: `Unknown /plugin marketplace subcommand: ${subsub}` };
				}
				return { ok: false, error: `Unknown /plugin subcommand: ${sub}` };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		if (name === "/provider") {
			const [sub, rest] = splitArg(arg);
			const settings = loadSettings();
			const providers = settings.providers ?? [];
			if (!sub || sub === "list") {
				// Active = the saved provider (matched by name, falling back to url+key
				// for legacy settings that pre-date modelProvider). Two providers can
				// share a URL, so URL-only matching silently mislabels the second one
				// as "active" and the chat footer / model picker then show the wrong name.
				const savedSettings = loadSettings();
				const savedName = savedSettings.modelProvider;
				const activeByName = savedName ? providers.find((p) => p.name === savedName) : undefined;
				const activeByCreds = providers.find((p) => p.url === config.baseURL && p.apiKey === config.apiKey);
				const active = activeByName ?? activeByCreds;
				return {
					ok: true,
					result: providers.map((p) => ({ name: p.name, url: p.url, active: p === active })),
				};
			}
			if (sub === "delete") {
				if (!rest) return { ok: false, error: "Usage: /provider delete <name>" };
				const removed = providers.find((p) => p.name === rest);
				const remaining = providers.filter((p) => p.name !== rest);
				if (remaining.length === providers.length) return { ok: false, error: `Unknown provider: ${rest}` };
				const deletingActive = removed?.url === config.baseURL && removed?.apiKey === config.apiKey;
				const deletingMain = settings.modelProvider === rest;
				if (deletingActive && remaining.length > 0) {
					const fallback = remaining[0]!;
					config.baseURL = fallback.url;
					config.apiKey = fallback.apiKey;
					ws.session.providerUrl = fallback.url;
					ws.session.providerName = fallback.name;
					config.reasoningFormat = resolveReasoningFormat(fallback.url, fallback.reasoningFormat);
					config.reasoningParams = buildReasoningParams(
						config.reasoningLevel,
						config.reasoningFormat,
						ws.session.model,
					);
					ws.session.model = "";
					updateSettings({
						providers: remaining,
						providerUrl: fallback.url,
						apiKey: fallback.apiKey,
						modelProvider: fallback.name,
						model: "",
					});
					saveSession(ws.session);
					return { ok: true, result: `Deleted provider "${rest}" — switched to "${fallback.name}"` };
				}
				updateSettings({
					providers: remaining,
					...(deletingMain ? { modelProvider: undefined } : {}),
					...(deletingActive ? { providerUrl: "", apiKey: "", modelProvider: undefined, model: "" } : {}),
				});
				if (deletingActive) {
					config.baseURL = "";
					config.apiKey = "";
					ws.session.providerUrl = undefined;
					ws.session.providerName = undefined;
					ws.session.model = "";
					saveSession(ws.session);
				}
				return { ok: true, result: `Deleted provider "${rest}"` };
			}
			if (sub === "add") {
				// Flat form since there's no wizard on the web: /provider add <name> <url> <apiKey>
				const parts = rest.split(WHITESPACE_SPLIT);
				const [pname, url, apiKey] = parts;
				if (!pname || !url || !apiKey) return { ok: false, error: "Usage: /provider add <name> <url> <apiKey>" };
				const next = [
					...providers.filter((p) => p.name !== pname),
					{ name: pname, url, apiKey, reasoningFormat: "auto" as const },
				];
				// No active provider yet (e.g. first add) → make this the default
				// so the main model has a working endpoint. Selection of a
				// different provider for any slot happens in the Model tab.
				if (!config.baseURL) {
					config.baseURL = url;
					config.apiKey = apiKey;
					ws.session.providerUrl = url;
					ws.session.providerName = pname;
					updateSettings({ providers: next, providerUrl: url, apiKey, modelProvider: pname });
					return { ok: true, result: `Added provider "${pname}" and set it active (default)` };
				}
				updateSettings({ providers: next });
				return { ok: true, result: `Added provider "${pname}" — pick it in the Model tab to use it` };
			}
			// Bare name — switch to it (or override its reasoning protocol).
			const target = providers.find((p) => p.name === sub);
			if (!target) return { ok: false, error: `Unknown provider: ${sub}. See /provider for the list.` };
			if (rest.startsWith("reasoning")) {
				// /provider <name> reasoning <format> — override the auto-detected
				// reasoning protocol for a provider whose endpoint isn't recognized
				// by URL (proxies, aggregators). Auto-detection via
				// resolveReasoningFormat is the default; this is the escape hatch.
				const fmt = rest.slice("reasoning".length).trim();
				if (!fmt) return { ok: false, error: "Usage: /provider <name> reasoning <format>" };
				const accepted = [...new Set(["auto", "generic", ...REASONING_FORMAT_OPTIONS.map((o) => o.value)])];
				if (!accepted.includes(fmt)) {
					return {
						ok: false,
						error: `Unknown reasoning format "${fmt}". Use: ${accepted.join(", ")}`,
					};
				}
				const next = providers.map((p) => (p.name === sub ? { ...p, reasoningFormat: fmt as ReasoningFormat } : p));
				updateSettings({ providers: next });
				if (settings.modelProvider === sub) {
					config.reasoningFormat = resolveReasoningFormat(target.url, fmt as ReasoningFormat);
					config.reasoningParams = buildReasoningParams(
						config.reasoningLevel,
						config.reasoningFormat,
						ws.session.model,
					);
				}
				return { ok: true, result: `Provider "${sub}" reasoning protocol: ${fmt}` };
			}
			const probe = await probeProvider({ ...config, baseURL: target.url, apiKey: target.apiKey });
			if (probe !== "ok" && probe !== "unknown") {
				return { ok: false, error: `Provider "${sub}" isn't reachable (${probe}) — not switched` };
			}
			config.baseURL = target.url;
			config.apiKey = target.apiKey;
			ws.session.providerUrl = target.url;
			ws.session.providerName = target.name;
			config.reasoningFormat = resolveReasoningFormat(target.url, target.reasoningFormat);
			config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, ws.session.model);
			// Switching the active provider invalidates every model id that was
			// chosen against the old endpoint, so reset them — the user re-picks on
			// the new provider. Slots with their own provider override keep their
			// model (it isn't tied to the active provider).
			ws.session.model = "";
			if (!subagentModelProvider) subagentModel = undefined;
			if (!planModelProvider) planModel = undefined;
			updateSettings({
				providerUrl: target.url,
				apiKey: target.apiKey,
				modelProvider: target.name,
				model: "",
				...(subagentModelProvider ? {} : { subagentModel: undefined }),
				...(planModelProvider ? {} : { planModel: undefined }),
			});
			saveSession(ws.session);
			return { ok: true, result: `Switched to provider "${sub}" — pick a model with /model` };
		}
		if (name === "/ssh") {
			const [sub, rest] = splitArg(arg);
			if (!sub || sub === "list") {
				return {
					ok: true,
					result: sshHosts.map((h) => ({
						name: h.name,
						host: h.host,
						username: h.username,
						port: h.port,
						keyPath: h.keyPath,
						password: !!h.password,
					})),
				};
			}
			if (sub === "remove") {
				if (!rest) return { ok: false, error: "Usage: /ssh remove <name>" };
				const remaining = sshHosts.filter((h) => h.name !== rest);
				if (remaining.length === sshHosts.length) return { ok: false, error: `Unknown host: ${rest}` };
				sshHosts = remaining;
				saveSshConfig(sshHosts);
				return { ok: true, result: `Removed host "${rest}"` };
			}
			if (sub === "add") {
				// Flat form (no wizard): /ssh add <name> <host> [username] [port] [keyPath] [password]
				// "-" is an explicit placeholder for a skipped optional field (so a
				// later positional arg, e.g. port, can be given without the earlier
				// one) — it never means a literal username/key path of "-".
				const parts = rest.split(WHITESPACE_SPLIT).map((p) => (p === "-" ? undefined : p));
				const [hname, host, username, portStr, keyPath, password] = parts;
				if (!hname || !host)
					return { ok: false, error: "Usage: /ssh add <name> <host> [username] [port] [keyPath] [password]" };
				const port = portStr ? Number.parseInt(portStr, 10) : undefined;
				sshHosts = [
					...sshHosts.filter((h) => h.name !== hname),
					{ name: hname, host, username, port, keyPath, password },
				];
				saveSshConfig(sshHosts);
				return { ok: true, result: `Added host "${hname}"` };
			}
			return { ok: false, error: `Unknown /ssh subcommand: ${sub}` };
		}

		if (name === "/undo") {
			if (running) return { ok: false, error: "Agent running — finish the run or /abort before /undo" };
			const checkpoints = ws.session.checkpoints || [];
			if (checkpoints.length === 0) return { ok: false, error: "No checkpoint available to undo" };
			const lastCheckpoint = checkpoints.pop()!;
			const res = restoreCheckpoint(lastCheckpoint);
			if (!res.ok) return { ok: false, error: `Undo failed: ${res.message}` };
			// Drop the matching row so the persisted list stays in sync.
			dropLastCheckpoint(ws.session.id);

			const msgs = ws.session.messages;
			let lastUserIdx = -1;
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]?.role === "user") {
					lastUserIdx = i;
					break;
				}
			}
			if (lastUserIdx !== -1) {
				ws.session.messages = msgs.slice(0, lastUserIdx);
			}
			ws.session.checkpoints = checkpoints;
			saveSession(ws.session);
			broadcastSessionUpdate(ws);
			return { ok: true, result: `Undone: ${res.message}` };
		}

		// Native `/<skill-id>` invocation — falls through here only once every
		// built-in name above has failed to match, so a skill can never shadow a
		// built-in command. Mirrors /rule:'s "submit as a real user turn" shape,
		// including the manual idle gate (skill commands aren't blocking, so they
		// don't hit the isCommandBlocking gate above, same as /rule:).
		const skillId = name.slice(1);
		if (skillId && !CLIENT_PARITY_COMMANDS.has(name)) {
			const sessionCwd = ws.session.cwd ?? cwd;
			const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
			const disabled = new Set(loadSettings().disabledSkills ?? []);
			const skill = discovered.find((s) => s.name === skillId && !disabled.has(s.name) && s.pluginEnabled !== false);
			if (skill) {
				if (running) return { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
				fireUserPromptExpansion(sessionCwd, skill.name);
				submit(sessionId, formatSkillInvocation(skill, arg));
				return { ok: true, result: `Invoked skill: ${skill.name}` };
			}
		}

		// Headless/JSONL parity commands — the TUI handles these client-side
		// (clipboard, display settings, keybindings, worktree switching), but the
		// daemon returns an equivalent result so a `cast run --interactive`
		// consumer can round-trip every slash command instead of hitting
		// "Unknown command".
		if (name === "/quit" || name === "/exit") {
			// Alias of /abort for the running case; idle sessions just report ok.
			if (running) {
				ws.runner.abort();
				return { ok: true, result: "quit requested" };
			}
			return { ok: true, result: "idle" };
		}
		if (name === "/copy") {
			const last = [...ws.session.messages].reverse().find((m) => m.role === "assistant" && m.content);
			return {
				ok: true,
				result: last ? (typeof last.content === "string" ? last.content : "assistant message") : "",
			};
		}
		if (name === "/older") {
			// In the TUI /older prepends the previous history page to the
			// scrollback. Headless has no scrollback; report whether older
			// turns exist (the web client pages them via GET
			// /api/sessions/:id/history?before=<seq>).
			const page = getHistoryPage(ws.session.id, undefined, 1);
			return { ok: true, result: { hasMoreHistory: page.hasMore, oldestSeq: page.oldestSeq ?? null } };
		}
		if (name === "/keys") {
			return { ok: true, result: "keybindings are a TUI concept; see docs or /help for commands" };
		}
		if (name === "/statusbar") {
			return { ok: true, result: loadSettings().statusBar ?? { visible: [], order: [], sides: {} } };
		}
		if (name === "/reasoning-display" || name === "/rd") {
			const next = !(loadSettings().showReasoning ?? true);
			updateSettings({ showReasoning: next });
			return { ok: true, result: { showReasoning: next } };
		}
		if (name === "/reasoning-format") {
			const current = config.reasoningFormat;
			const options = REASONING_FORMAT_OPTIONS.map((o) => o.value);
			if (!arg) return { ok: true, result: { reasoningFormat: current, options } };
			if (!options.includes(arg as (typeof options)[number])) {
				return { ok: false, error: `Unknown reasoning format: ${arg}. Options: ${options.join(", ")}` };
			}
			config.reasoningFormat = resolveReasoningFormat(config.baseURL, arg as (typeof options)[number]);
			const selected = arg as (typeof options)[number];
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
		}
		if (name === "/worktree") {
			const sessionCwd = ws.session.cwd ?? cwd;
			if (!arg) {
				return { ok: false, error: "Usage: /worktree <name> | /worktree list | /worktree remove <name>" };
			}
			if (arg === "list") {
				const wts = listWorktrees(sessionCwd);
				if (wts.length === 0) return { ok: true, result: "No active git worktrees found for this repository" };
				return { ok: true, result: wts.map((w) => `${w.name} (${w.branch})`).join(", ") };
			}
			const rmMatch = WORKTREE_REMOVE_PREFIX_RE.exec(arg);
			if (rmMatch) {
				const targetName = rmMatch[1]!.trim();
				if (!targetName) return { ok: false, error: "Usage: /worktree remove <name>" };
				const target = listWorktrees(sessionCwd).find((worktree) => worktree.name === targetName);
				const res = await removeWorktreeBySlug(targetName, sessionCwd);
				if (res.ok) {
					void runHooksForEvent(resolveHooksForCwd(sessionCwd, projectTrusted), {
						event: "WorktreeRemove",
						cwd: sessionCwd,
						sessionId: ws.id,
						payload: { worktree_name: targetName, worktree_path: target?.path },
					});
				}
				return { ok: true, result: res.message };
			}
			if (running)
				return { ok: false, error: "Agent running — finish the run or /abort before switching worktrees" };
			try {
				const beforeCreate = await runHooksForEvent(resolveHooksForCwd(sessionCwd, projectTrusted), {
					event: "WorktreeCreate",
					cwd: sessionCwd,
					sessionId: ws.id,
					payload: { worktree_name: arg },
				});
				if (beforeCreate.blocked)
					return { ok: false, error: beforeCreate.reason ?? "Worktree creation blocked by hook" };
				const wt = await ensureSessionWorktree(arg, sessionCwd);
				const previousCwd = ws.session.cwd;
				ws.session.cwd = wt.path;
				saveSession(ws.session);
				// Rebuild the system prompt against the worktree's context (skills,
				// rules, MCP, trust) so the next turn sees the worktree's world.
				ws.systemPrompt = computeSystemPrompt(
					resolvePersona(ws.session.persona ?? "") ?? currentPersona,
					ws.session.model,
					wt.path,
					ws.session.mode,
				);
				void runHooksForEvent(resolveHooksForCwd(wt.path, projectTrusted), {
					event: "CwdChanged",
					cwd: wt.path,
					sessionId: ws.id,
					payload: { old_cwd: previousCwd, cwd: wt.path },
				});
				broadcastSessionUpdate(ws);
				return { ok: true, result: `Worktree ready: ${wt.path}` };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}

		return { ok: false, error: `Unknown command: ${cmd}` };
	}

	async function executeSettingsCommand(command: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const name = command.trim().split(WHITESPACE_SPLIT, 1)[0];
		const allowed = new Set([
			"/current",
			"/permissions",
			"/web",
			"/memory",
			"/web-search-provider",
			"/web-fetch-provider",
			"/theme",
			"/hooks",
			"/model-selection",
			"/model",
			"/reasoning",
			"/quick-session-persona",
			"/subagent-model",
			"/subagent-model-provider",
			"/plan-model",
			"/plan-model-provider",
			"/reload",
			"/mcp",
			"/skills",
			"/skills-sh",
			"/plugin",
			"/provider",
			"/ssh",
			"/turn-cap",
		]);
		if (!allowed.has(name ?? "")) return { ok: false, error: "Command requires an active session" };

		// The command implementation is shared with the TUI and normally needs a
		// session for its current model/cwd. Keep this context private: it never
		// reaches the sidebar, disk, or user hooks, and is removed synchronously.
		const ws = createSessionInstance(undefined, undefined, undefined, false);
		try {
			return await executeCommand(ws.id, command);
		} finally {
			ws.backgroundBash.registry.killAll();
			sessions.delete(ws.id);
			deleteSession(ws.id);
		}
	}

	function getConfig() {
		return {
			baseURL: config.baseURL,
			model: defaultModel,
			persona: currentPersona.name,
			theme: loadSettings().theme ?? "cast",
			cwd,
			quickSessionPersona,
			memoryEnabled: loadSettings().memoryEnabled !== false,
		};
	}

	function getPersonas() {
		return personas.map((p) => ({
			name: p.name,
			label: p.label,
			description: p.description,
			source: p.source,
		}));
	}

	function getThemes() {
		return ALL_THEMES.map((t) => ({ id: t.id, label: t.label, description: t.description, colors: t.colors }));
	}

	/** Live provider /v1/models call — same one the TUI's /model picker makes
	 * (core/config.ts's fetchModels), fetched fresh per request rather than
	 * cached, since a stale list would just silently hide newly available
	 * models from the picker. */
	/**
	 * Verify arbitrary provider credentials without saving them — used by the
	 * web Settings UI's "Verify" button and as a mandatory pre-save gate.
	 * Returns the classified probe result so the UI can show a specific reason
	 * (auth / permission / unreachable) rather than a bare failure.
	 */
	async function verifyProvider(url: string, apiKey: string): Promise<{ ok: boolean; probe: string; error?: string }> {
		if (!url || !apiKey) return { ok: false, probe: "unknown", error: "URL and API key are required" };
		const probe = await probeProvider({ ...config, baseURL: url, apiKey });
		if (probe === "ok" || probe === "unknown") return { ok: true, probe };
		return { ok: false, probe, error: probe };
	}

	async function getModels(providerName?: string): Promise<{ models: ModelInfo[]; error?: string }> {
		let fetchConfig = config;
		if (providerName) {
			const currentSettings = loadSettings();
			const provider = (currentSettings.providers ?? []).find((p) => p.name === providerName);
			if (provider) fetchConfig = { ...config, baseURL: provider.url, apiKey: provider.apiKey };
		}
		const result = await fetchModels(fetchConfig);
		if (result.ok && result.models) {
			if (!providerName) setModelsCache(result.models);
			return { models: result.models };
		}
		return { models: [], error: result.error };
	}

	function getCachedModels(): { models: ModelInfo[] } {
		return { models: getModelsCache() };
	}

	function saveSshKey(name: string, keyContent: string): { ok: boolean; path?: string; error?: string } {
		try {
			const keysDir = join(homedir(), ".cast", "keys");
			if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
			const keyPath = join(keysDir, name);
			writeFileSync(keyPath, keyContent.endsWith("\n") ? keyContent : `${keyContent}\n`, "utf-8");
			chmodSync(keyPath, 0o600);
			return { ok: true, path: keyPath };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function addSshHost(
		name: string,
		host: string,
		username: string | undefined,
		port: number | undefined,
		keyPath: string | undefined,
		password: string | undefined,
	): { ok: boolean; error?: string } {
		if (!name || !host) return { ok: false, error: "Name and host are required" };
		sshHosts = [...sshHosts.filter((h) => h.name !== name), { name, host, username, port, keyPath, password }];
		saveSshConfig(sshHosts);
		return { ok: true };
	}

	function readSkillContent(name: string): { ok: boolean; content?: string; error?: string } {
		try {
			const sessionCwd = sessions.values().next().value?.session.cwd ?? cwd;
			const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
			const skill = discovered.find((s) => s.name === name);
			if (!skill) return { ok: false, error: `Skill "${name}" not found` };
			const raw = readFileSync(skill.filePath, "utf-8");
			// Strip frontmatter
			const content = raw.replace(FRONTMATTER_STRIP_RE, "");
			return { ok: true, content };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function readPersonaContent(name: string): { ok: boolean; content?: string; error?: string } {
		try {
			const persona = personas.find((candidate) => candidate.name === name);
			if (!persona) return { ok: false, error: `Persona "${name}" not found` };
			if (!persona.filePath) return { ok: false, error: `Persona "${name}" has no source file` };
			const raw = readFileSync(persona.filePath, "utf-8");
			const content = raw.replace(FRONTMATTER_STRIP_RE, "");
			return { ok: true, content };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function readPluginContent(pluginId: string): { ok: boolean; content?: string; error?: string } {
		try {
			const pluginDir = join(homedir(), ".cast", "plugins", "installs");
			// pluginId format: name@marketplace
			const parts = pluginId.split("@");
			if (parts.length < 2) return { ok: false, error: `Invalid plugin id: ${pluginId}` };
			const pluginName = parts[0];
			const marketplace = parts.slice(1).join("@");
			const root = join(pluginDir, marketplace, pluginName);
			// Collect existing SKILL.md files: root first, then skills/*/SKILL.md
			const candidates: string[] = [];
			const rootSkill = join(root, "SKILL.md");
			if (existsSync(rootSkill)) candidates.push(rootSkill);
			try {
				const skillsDir = join(root, "skills");
				if (existsSync(skillsDir)) {
					for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
						if (d.isDirectory()) {
							const p = join(skillsDir, d.name, "SKILL.md");
							if (existsSync(p)) candidates.push(p);
						}
					}
				}
			} catch {
				/* ignore */
			}
			if (candidates.length === 0) return { ok: false, error: `No SKILL.md found in ${root}` };
			// Concatenate all skill files
			const content = candidates
				.map((p) => {
					const raw = readFileSync(p, "utf-8");
					return raw.replace(FRONTMATTER_STRIP_RE, "");
				})
				.join("\n\n---\n\n");
			return { ok: true, content };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	function getReasoningOptionsForSession(sessionId: string): { options: Array<{ value: string; label: string }> } {
		const ws = sessions.get(sessionId) ?? hydrateSession(sessionId);
		const model = ws?.session.model ?? defaultModel;
		return { options: reasoningOptionsFor(model) };
	}

	function suggestCommand(sessionId: string, input: string): Array<{ value: string; label: string }> {
		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) return [];
		const spaceIdx = trimmed.indexOf(" ");
		const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
		const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
		const settings = loadSettings();

		if (cmd === "/mcp") {
			if (!arg) return ["list", "enable", "disable", "uninstall", "help"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(WHITESPACE_SPLIT);
			if (sub === "enable") {
				const disabled = new Set(settings.disabledMcpServers ?? []);
				return mcpResult.allServerNames.filter((n) => disabled.has(n)).map((v) => ({ value: v, label: v }));
			}
			if (sub === "disable") {
				const disabled = new Set(settings.disabledMcpServers ?? []);
				return mcpResult.allServerNames.filter((n) => !disabled.has(n)).map((v) => ({ value: v, label: v }));
			}
			if (sub === "uninstall") return mcpResult.allServerNames.map((v) => ({ value: v, label: v }));
			return [];
		}

		if (cmd === "/skills") {
			if (!arg) return ["list", "enable", "disable", "uninstall", "help"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(WHITESPACE_SPLIT);
			const sessionCwd = sessions.get(sessionId)?.session.cwd ?? cwd;
			const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
			if (sub === "enable") {
				const disabled = new Set(settings.disabledSkills ?? []);
				return discovered.filter((s) => disabled.has(s.name)).map((s) => ({ value: s.name, label: s.description }));
			}
			if (sub === "disable") {
				const disabled = new Set(settings.disabledSkills ?? []);
				return discovered
					.filter((s) => !disabled.has(s.name))
					.map((s) => ({ value: s.name, label: s.description }));
			}
			if (sub === "uninstall")
				return discovered.filter(isUninstallableSkill).map((s) => ({ value: s.name, label: s.description }));
			return [];
		}

		if (cmd === "/plugin") {
			if (!arg)
				return ["list", "install", "uninstall", "enable", "disable", "marketplace", "help"].map((v) => ({
					value: v,
					label: v,
				}));
			const [sub] = arg.split(WHITESPACE_SPLIT);
			if (sub === "marketplace" && !arg.slice(sub.length).trim())
				return ["list", "add", "remove", "update"].map((v) => ({ value: v, label: v }));
			if (sub === "enable" || sub === "disable" || sub === "uninstall") {
				return listInstalledPlugins(settings).map((p) => ({ value: p.id, label: p.description ?? p.id }));
			}
			if (sub === "install") {
				const catalogs = listKnownMarketplaces();
				const items: Array<{ value: string; label: string }> = [];
				for (const mp of catalogs) {
					try {
						const cat = getMarketplaceCatalog(mp.name);
						for (const p of cat.plugins) items.push({ value: p.name, label: p.description ?? p.name });
					} catch {
						/* skip broken catalogs */
					}
				}
				return items;
			}
			return [];
		}

		if (cmd === "/provider") {
			const providers = settings.providers ?? [];
			if (!arg)
				return ["list", "add", "delete", ...providers.map((p) => p.name)].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(WHITESPACE_SPLIT);
			if (sub === "delete") return providers.map((p) => ({ value: p.name, label: p.name }));
			return [];
		}

		if (cmd === "/ssh") {
			if (!arg) return ["list", "add", "remove"].map((v) => ({ value: v, label: v }));
			const [sub] = arg.split(WHITESPACE_SPLIT);
			if (sub === "remove") return sshHosts.map((h) => ({ value: h.name, label: h.name }));
			return [];
		}

		if (cmd === "/permissions") {
			if (!arg) return ["default", "bypass"].map((v) => ({ value: v, label: v }));
			return [];
		}

		if (cmd === "/plan-model") {
			if (!arg) {
				const models = getModelsCache() ?? [];
				return [
					...models.map((m) => ({ value: m.id, label: m.id })),
					{ value: "off", label: "off" },
					{ value: "reset", label: "reset" },
				];
			}
			return [];
		}

		if (cmd === "/subagent-model") {
			if (!arg) {
				const models = getModelsCache() ?? [];
				return models.map((m) => ({ value: m.id, label: m.id }));
			}
			return [];
		}

		return [];
	}

	// Merges the static built-in palette with one live entry per loaded,
	// enabled skill — this is what makes `/some-skill` a first-class slash
	// command instead of routing through a generic `/skill:name` prefix, and
	// why the client needs to re-fetch this (see GET /api/sessions/:id/commands)
	// after /reload or a session/cwd switch instead of caching it once at boot.
	// Skips any skill whose id collides with a built-in command name — the
	// built-in always wins (executeCommand's dispatch order guarantees this
	// too: every built-in `name ===` check runs before the skill fallback).
	function getSlashCommands(sessionId?: string): typeof SLASH_COMMANDS {
		if (!sessionId) return SLASH_COMMANDS;
		const sessionCwd = sessions.get(sessionId)?.session.cwd ?? cwd;
		const disabled = new Set(loadSettings().disabledSkills ?? []);
		const builtinNames = new Set(SLASH_COMMANDS.map((c) => c.name));
		const discovered = discoverSkillsForCwd(projectDeps, sessionCwd, projectTrusted);
		const skillCommands = discovered
			.filter((s) => !disabled.has(s.name) && s.pluginEnabled !== false && !builtinNames.has(`/${s.name}`))
			.map((s) => ({
				name: `/${s.name}`,
				description: s.description,
				takesArgs: true,
				blocking: false,
			}));
		return [...SLASH_COMMANDS, ...skillCommands];
	}

	return {
		createSession: createSessionInstance,
		forkSession: forkSessionInstance,
		getSession,
		listSessions,
		searchSessions,
		applyMcpResult,
		closeSession,
		deleteSessionPermanently,
		renameSession,
		pinSession,
		shareSession,
		unshareSession,
		getSharedSession,
		getSharedLiveSession,
		submit,
		steer,
		followUp,
		getQuestion,
		answerQuestion,
		getPlanTransition,
		resolvePlanTransition: resolvePersistedPlanTransition,
		setSessionMode,
		resetContext,
		abort,
		subscribe,
		unsubscribe,
		subscribeAll,
		unsubscribeAll,
		dispose: unsubscribeActorNotifications,
		executeCommand,
		executeSettingsCommand,
		getConfig,
		getPersonas,
		getThemes,
		getModels,
		verifyProvider,
		getCachedModels,
		saveSshKey,
		addSshHost,
		readSkillContent,
		readPersonaContent,
		readPluginContent,
		getReasoningOptionsForSession,
		suggestCommand,
		getSlashCommands,
	};
}

function getHelpText(): string {
	// No column-padding here — this renders through the same proportional-font
	// markdown pipe as chat prose, where fixed-width alignment doesn't hold.
	// Hidden commands (MCP/skills/plugins/provider/SSH/theme/...) live in the
	// Settings modal now, not this list — repeating them here would be the
	// exact chat clutter that modal exists to avoid.
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
		"*MCP, skills, plugins, provider, SSH, theme, model/reasoning details, and usage live in Settings (gear icon).*",
	].join("\n");
}
