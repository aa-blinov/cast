import { inputTokenBudget } from "../core/config.ts";
import type { SessionUsage } from "../core/session.ts";
import { estimateTokens } from "../core/session.ts";
import type { StatusBarConfig } from "../core/settings.ts";
import { abbreviateTokens } from "./format-tokens.ts";

// ============================================================================
// Segment context — data passed to every segment's text function
// ============================================================================

export interface SegmentContext {
	persona: string;
	planMode: boolean;
	/** Model actually in use right now: the plan override when plan mode is on
	 * with one, otherwise the configured model. */
	activeModel: string;
	/** The configured model — stays the same across plan/build toggles, so
	 * /current can show when the live model diverges from it. */
	configuredModel: string;
	/** Plan-mode override (when set, used while plan mode is on). Undefined
	 * when no override is configured. */
	planModel: string | undefined;
	usage: SessionUsage | undefined;
	lastTurnUsage: { tokensPerSecond?: number } | undefined;
	elapsedMs: number;
	/** A turn is in progress: the elapsed time is ticking, not the length of the last one. */
	running?: boolean;
	messageCount: number;
	contextWindow: number;
	maxResponseTokens: number;
	messages: import("../core/llm.ts").Message[];
	sessionId: string;
	worktree?: string;
	/** The working folder, as the full path. */
	cwd?: string;
	/** Language servers running for this cast (ids), for the `lsp` segment. */
	lspServers?: string[];
	/** The session's goal as one phrase (`goal active`), for the `goal` segment. */
	goal?: string;
}

// ============================================================================
// Segment descriptor
// ============================================================================

export interface StatusBarSegment {
	id: string;
	label: string;
	defaultOn: boolean;
	side: "left" | "right";
	/**
	 * The segment's text for the status bar and the /current command.
	 * Returning null means "no data": the bar leaves the segment out and the
	 * command prints an em-dash.
	 */
	formatValue: (ctx: SegmentContext) => string | null;
}

const segments: StatusBarSegment[] = [];

export function registerStatusBarSegment(seg: StatusBarSegment): void {
	segments.push(seg);
}

export function getStatusBarSegments(): readonly StatusBarSegment[] {
	return segments;
}

/**
 * Which segments go first when the bar is wider than the terminal: the least
 * useful at a glance first. Mode, model and the running time stay longest.
 * A segment not listed (a plugin's) goes before all of these.
 */
export const SEGMENT_DROP_ORDER = [
	"session",
	"subagent",
	"speed",
	"cost",
	"lsp",
	"usage",
	"folder",
	"context",
	"goal",
	"worktree",
	"persona",
	"model",
	"mode",
	"elapsed",
];

/** Whole seconds: the counter moves on the 500ms animation clock, where tenths would flicker between .0 and .5. */
export function formatElapsed(ms: number): string {
	return `${Math.floor(ms / 1000)}s`;
}

/**
 * The segments that fit `columns`, whole: cutting one mid-text (`Senior
 * Developer │ …ctx`) lost the mode and model while keeping the token count.
 * Widths come from each segment's plain text; ` * ` joins them all.
 */
export function fitSegments<T extends { id: string; text: string; side: "left" | "right" }>(
	items: T[],
	columns: number,
	width: (text: string) => number,
): T[] {
	const kept = [...items];
	// One row, one separator (` * `, three cells) between all of them: no padding to the far edge.
	const total = () => kept.reduce((acc, i) => acc + width(i.text), 0) + 3 * Math.max(0, kept.length - 1);
	const rank = (id: string) => SEGMENT_DROP_ORDER.indexOf(id);
	while (kept.length > 1 && total() > columns) {
		let drop = 0;
		for (let i = 1; i < kept.length; i++) if (rank(kept[i]!.id) < rank(kept[drop]!.id)) drop = i;
		kept.splice(drop, 1);
	}
	return kept;
}

/** Default config derived from registry defaults. */
export function defaultStatusBarConfig(): StatusBarConfig {
	const all = getStatusBarSegments();
	return {
		visible: all.filter((s) => s.defaultOn).map((s) => s.id),
		order: all.map((s) => s.id),
		sides: Object.fromEntries(all.map((s) => [s.id, s.side])),
	};
}

// Width estimates for overflow warning (worst-case typical widths).
export const SEGMENT_MAX_WIDTH: Record<string, number> = {
	persona: 20,
	mode: 8,
	model: 30,
	worktree: 16,
	folder: 28,
	session: 16,
	context: 22,
	usage: 35,
	cost: 8,
	speed: 12,
	elapsed: 7,
	subagent: 9,
	lsp: 20,
	goal: 18,
};

// ============================================================================
// Core segment registrations
// ============================================================================

registerStatusBarSegment({
	id: "persona",
	label: "Persona",
	defaultOn: true,
	side: "left",
	formatValue: (ctx) => ctx.persona,
});

registerStatusBarSegment({
	id: "mode",
	label: "Mode",
	defaultOn: true,
	side: "left",
	formatValue: (ctx) => (ctx.planMode ? "PLAN" : "BUILD"),
});

registerStatusBarSegment({
	id: "model",
	label: "Model",
	defaultOn: true,
	side: "left",
	// When plan mode swaps in a separate plan model, /current shows the
	// configured model and tags the live one in parens — otherwise the
	// status bar reads one model and the user wonders where the other came from.
	formatValue: (ctx) => {
		if (ctx.planMode && ctx.planModel && ctx.planModel !== ctx.configuredModel) {
			return `${ctx.configuredModel} (plan: ${ctx.activeModel})`;
		}
		return ctx.activeModel;
	},
});

/** The folder with the home directory as `~`. */
export function tildePath(path: string): string {
	const home = process.env.HOME ?? "";
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

registerStatusBarSegment({
	id: "folder",
	label: "Folder",
	defaultOn: true,
	side: "left",
	formatValue: (ctx) => (ctx.cwd ? tildePath(ctx.cwd) : null),
});

registerStatusBarSegment({
	id: "worktree",
	label: "Git Worktree",
	defaultOn: true,
	side: "left",
	formatValue: (ctx) => (ctx.worktree ? `wt:${ctx.worktree}` : null),
});

registerStatusBarSegment({
	id: "session",
	label: "Session",
	defaultOn: false,
	side: "left",
	formatValue: (ctx) => ctx.sessionId,
});

/** How much of the input budget the conversation takes; null before there is one or without a known window. */
export function contextUsage(ctx: SegmentContext): { used: number; budget: number; pct: number } | null {
	if (ctx.messages.length === 0 || !(ctx.contextWindow > 0)) return null;
	const used = estimateTokens(ctx.messages);
	const budget = inputTokenBudget(ctx);
	return { used, budget, pct: Math.round((used / budget) * 100) };
}

// On by default: a long session runs out of room without warning otherwise.
registerStatusBarSegment({
	id: "context",
	label: "Context %",
	defaultOn: true,
	side: "right",
	formatValue: (ctx) => {
		if (ctx.messages.length === 0) return null;
		const usage = contextUsage(ctx);
		if (!usage) return "ctx ?";
		return `ctx ${abbreviateTokens(usage.used)}/${abbreviateTokens(usage.budget)} (${usage.pct}%)`;
	},
});

const usageCacheSuffix = (u: SessionUsage): string => {
	if ((!u.cacheReadTokens && !u.cacheWriteTokens) || u.promptTokens <= 0) return "";
	return ` (${Math.round((u.cacheReadTokens / u.promptTokens) * 100)}% cached)`;
};

registerStatusBarSegment({
	id: "usage",
	label: "Tokens in/out",
	defaultOn: false,
	side: "right",
	formatValue: (ctx) => {
		const u = ctx.usage;
		if (!u || u.totalTokens <= 0) return null;
		return `${abbreviateTokens(u.promptTokens)} in${usageCacheSuffix(u)} / ${abbreviateTokens(u.completionTokens)} out`;
	},
});

registerStatusBarSegment({
	id: "cost",
	label: "Cost",
	defaultOn: false,
	side: "right",
	formatValue: (ctx) => {
		const cost = ctx.usage?.cost;
		return cost ? `$${cost.toFixed(2)}` : null;
	},
});

registerStatusBarSegment({
	id: "speed",
	label: "Tok/s",
	defaultOn: false,
	side: "right",
	formatValue: (ctx) => {
		const tps = ctx.lastTurnUsage?.tokensPerSecond;
		return tps ? `${tps.toFixed(1)} tok/s` : null;
	},
});

registerStatusBarSegment({
	id: "lsp",
	label: "Language servers",
	defaultOn: false,
	side: "right",
	formatValue: (ctx) => (ctx.lspServers?.length ? ctx.lspServers.join(", ") : null),
});

registerStatusBarSegment({
	id: "goal",
	label: "Goal",
	defaultOn: true,
	side: "right",
	formatValue: (ctx) => ctx.goal ?? null,
});

registerStatusBarSegment({
	id: "elapsed",
	label: "Elapsed",
	defaultOn: true,
	side: "right",
	// Once the turn is over the number stays as the length of that turn, and says so.
	// Nothing to report before the session has had a turn, whatever the last session's clock said.
	formatValue: (ctx) =>
		ctx.elapsedMs > 0 && !(ctx.running === false && ctx.messageCount === 0)
			? `${ctx.running === false ? "took " : ""}${formatElapsed(ctx.elapsedMs)}`
			: null,
});

registerStatusBarSegment({
	id: "subagent",
	label: "Subagent tokens",
	defaultOn: false,
	side: "right",
	formatValue: (ctx) => {
		const u = ctx.usage;
		return u && u.subagentTokens > 0 ? `${abbreviateTokens(u.subagentTokens)} sub` : null;
	},
});
