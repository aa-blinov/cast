import { Text } from "ink";
import type { JSX } from "react";
import type { SessionUsage } from "../core/session.ts";
import { estimateTokens } from "../core/session.ts";
import type { StatusBarConfig } from "../core/settings.ts";
import { abbreviateTokens } from "./App.tsx";
import { theme } from "./themes/index.ts";

// ============================================================================
// Segment context — data passed to every segment's render function
// ============================================================================

export interface SegmentContext {
	persona: string;
	planMode: boolean;
	activeModel: string;
	usage: SessionUsage | undefined;
	lastTurnUsage: { tokensPerSecond?: number } | undefined;
	elapsedMs: number;
	messageCount: number;
	contextWindow: number;
	maxResponseTokens: number;
	messages: import("../core/llm.ts").Message[];
}

// ============================================================================
// Segment descriptor
// ============================================================================

export interface StatusBarSegment {
	id: string;
	label: string;
	defaultOn: boolean;
	side: "left" | "right";
	render: (ctx: SegmentContext) => JSX.Element | null;
}

const segments: StatusBarSegment[] = [];

export function registerStatusBarSegment(seg: StatusBarSegment): void {
	segments.push(seg);
}

export function getStatusBarSegments(): readonly StatusBarSegment[] {
	return segments;
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
	context: 22,
	usage: 35,
	speed: 12,
	elapsed: 7,
	subagent: 9,
};

// ============================================================================
// Core segment registrations
// ============================================================================

registerStatusBarSegment({
	id: "persona",
	label: "Persona",
	defaultOn: true,
	side: "left",
	render: (ctx) => <Text color={theme().persona}>{ctx.persona}</Text>,
});

registerStatusBarSegment({
	id: "mode",
	label: "Mode",
	defaultOn: true,
	side: "left",
	render: (ctx) =>
		ctx.planMode ? <Text color={theme().warning}>PLAN</Text> : <Text color={theme().muted}>BUILD</Text>,
});

registerStatusBarSegment({
	id: "model",
	label: "Model",
	defaultOn: true,
	side: "left",
	render: (ctx) => <Text color={theme().muted}>{ctx.activeModel}</Text>,
});

registerStatusBarSegment({
	id: "context",
	label: "Context %",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (ctx.messages.length === 0) return null;
		const used = estimateTokens(ctx.messages);
		const budget = ctx.contextWindow - ctx.maxResponseTokens;
		if (budget <= 0) return <Text color={theme().muted}>ctx ?</Text>;
		const pct = Math.round((used / budget) * 100);
		return (
			<Text color={theme().muted}>
				ctx {abbreviateTokens(used)}/{abbreviateTokens(ctx.contextWindow)} ({pct}%)
			</Text>
		);
	},
});

registerStatusBarSegment({
	id: "usage",
	label: "Tokens in/out",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.usage || ctx.usage.totalTokens <= 0) return null;
		const cacheStr =
			(ctx.usage.cacheReadTokens || ctx.usage.cacheWriteTokens) && ctx.usage.promptTokens > 0
				? ` (${Math.round((ctx.usage.cacheReadTokens / ctx.usage.promptTokens) * 100)}% cached)`
				: "";
		return (
			<Text color={theme().muted}>
				{abbreviateTokens(ctx.usage.promptTokens)} in{cacheStr} / {abbreviateTokens(ctx.usage.completionTokens)} out
			</Text>
		);
	},
});

registerStatusBarSegment({
	id: "speed",
	label: "Tok/s",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.lastTurnUsage?.tokensPerSecond) return null;
		return <Text color={theme().muted}>{ctx.lastTurnUsage.tokensPerSecond.toFixed(1)} tok/s</Text>;
	},
});

registerStatusBarSegment({
	id: "elapsed",
	label: "Elapsed",
	defaultOn: true,
	side: "right",
	render: (ctx) => {
		if (ctx.elapsedMs <= 0) return null;
		return <Text color={theme().muted}>{(ctx.elapsedMs / 1000).toFixed(1)}s</Text>;
	},
});

registerStatusBarSegment({
	id: "subagent",
	label: "Subagent tokens",
	defaultOn: false,
	side: "right",
	render: (ctx) => {
		if (!ctx.usage || ctx.usage.subagentTokens <= 0) return null;
		return <Text color={theme().muted}>{abbreviateTokens(ctx.usage.subagentTokens)} sub</Text>;
	},
});
