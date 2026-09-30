import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/llm.ts";
import {
	defaultStatusBarConfig,
	fitSegments,
	getStatusBarSegments,
	SEGMENT_DROP_ORDER,
	SEGMENT_MAX_WIDTH,
	type SegmentContext,
} from "../src/ui/statusbar.ts";

/** Empty-but-valid SegmentContext for the null-on-empty-data tests. */
function emptyCtx(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		persona: "Coding",
		planMode: false,
		activeModel: "m",
		configuredModel: "m",
		planModel: undefined,
		usage: undefined,
		lastTurnUsage: undefined,
		elapsedMs: 0,
		messageCount: 0,
		contextWindow: 128_000,
		maxResponseTokens: 8192,
		messages: [] as Message[],
		sessionId: "test-session",
		...overrides,
	};
}

describe("defaultStatusBarConfig", () => {
	it("lists only defaultOn segments as visible, in registration order", () => {
		const cfg = defaultStatusBarConfig();
		const allIds = getStatusBarSegments().map((s) => s.id);
		const defaultOnIds = getStatusBarSegments()
			.filter((s) => s.defaultOn)
			.map((s) => s.id);

		// Visible: every defaultOn id, no more, no less, in registration order.
		expect(cfg.visible).toEqual(defaultOnIds);

		// Order: every registered id, in registration order (matches the registry
		// so the picker initial layout matches the default).
		expect(cfg.order).toEqual(allIds);

		// Sides: every id has an entry, and it matches the segment's default side.
		for (const seg of getStatusBarSegments()) {
			expect(cfg.sides[seg.id]).toBe(seg.side);
		}
	});
});

describe("SEGMENT_MAX_WIDTH", () => {
	it("has an entry for every registered segment id (catches forgotten entries)", () => {
		for (const seg of getStatusBarSegments()) {
			expect(SEGMENT_MAX_WIDTH[seg.id]).toBeDefined();
		}
	});
});

describe("fitSegments", () => {
	const items = [
		{ id: "persona", side: "left" as const, text: "Senior Developer" },
		{ id: "mode", side: "left" as const, text: "BUILD" },
		{ id: "model", side: "left" as const, text: "test-model" },
		{ id: "session", side: "left" as const, text: "mum4ax6itgys0i" },
		{ id: "context", side: "right" as const, text: "ctx 6.1k/96k (6%)" },
		{ id: "cost", side: "right" as const, text: "$0.01" },
		{ id: "elapsed", side: "right" as const, text: "2.9s" },
	];
	const ids = (columns: number) => fitSegments(items, columns, (t) => t.length).map((i) => i.id);

	it("keeps everything that fits", () => {
		expect(ids(200)).toEqual(items.map((i) => i.id));
	});

	it("drops whole segments, least useful first, keeping mode, model and time", () => {
		// 31 + 2 separators left, 26 + 2 right, 1 between: exactly 70.
		expect(ids(70)).toEqual(["persona", "mode", "model", "context", "cost", "elapsed"]);
		expect(ids(62)).toEqual(["persona", "mode", "model", "context", "elapsed"]);
		expect(ids(45)).toEqual(["persona", "mode", "model", "elapsed"]);
		expect(ids(30)).toEqual(["mode", "model", "elapsed"]);
		expect(ids(5)).toEqual(["elapsed"]);
	});

	it("ranks every built-in segment", () => {
		for (const seg of getStatusBarSegments()) expect(SEGMENT_DROP_ORDER).toContain(seg.id);
	});
});

describe("segment renderers", () => {
	it("lsp lists the running servers, and shows nothing without any", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "lsp")!;
		expect(seg.formatValue(emptyCtx())).toBeNull();
		expect(seg.formatValue(emptyCtx({ lspServers: ["pyright", "typescript"] }))).toBe("pyright, typescript");
		expect(seg.formatValue(emptyCtx({ lspServers: ["typescript"] }))).not.toBeNull();
	});

	it("usage returns null when there's no usage", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "usage")!;
		expect(seg.formatValue(emptyCtx())).toBeNull();
	});

	it("usage returns null when totalTokens is zero", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "usage")!;
		const usage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
			subagentTokens: 0,
		};
		expect(seg.formatValue(emptyCtx({ usage }))).toBeNull();
	});

	it("subagent returns null when subagentTokens is zero", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "subagent")!;
		const usage = {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 100,
			subagentTokens: 0,
		};
		expect(seg.formatValue(emptyCtx({ usage }))).toBeNull();
	});

	it("elapsed returns null when elapsedMs is zero or negative", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "elapsed")!;
		expect(seg.formatValue(emptyCtx({ elapsedMs: 0 }))).toBeNull();
		expect(seg.formatValue(emptyCtx({ elapsedMs: -1 }))).toBeNull();
	});

	it("elapsed renders a positive elapsedMs as a non-null element", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "elapsed")!;
		expect(seg.formatValue(emptyCtx({ elapsedMs: 1500 }))).not.toBeNull();
	});

	it("session is off by default, left-aligned, and renders the sessionId", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "session")!;
		expect(seg.defaultOn).toBe(false);
		expect(seg.side).toBe("left");
		const ctx = emptyCtx({ sessionId: "abc123" });
		expect(seg.formatValue(ctx)).not.toBeNull();
		expect(seg.formatValue(ctx)).toBe("abc123");
		// Registered after `worktree`, before `context` — keeps default left side segment order.
		const ids = getStatusBarSegments().map((s) => s.id);
		expect(ids.indexOf("session")).toBe(ids.indexOf("worktree") + 1);
		expect(ids.indexOf("session")).toBeLessThan(ids.indexOf("context"));
	});
});

describe("segment formatValue (/current)", () => {
	it("model shows configured + active on separate lines when plan mode swaps the model", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "model")!;
		const value = seg.formatValue(
			emptyCtx({
				planMode: true,
				planModel: "opus",
				configuredModel: "haiku",
				activeModel: "opus",
			}),
		);
		expect(value).toBe("haiku (plan: opus)");
	});

	it("model collapses to activeModel when no plan override is in effect", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "model")!;
		const value = seg.formatValue(
			emptyCtx({
				planMode: true,
				planModel: undefined,
				configuredModel: "haiku",
				activeModel: "haiku",
			}),
		);
		expect(value).toBe("haiku");
	});

	it("usage and subagent return null when there's nothing to show", () => {
		const usage = getStatusBarSegments().find((s) => s.id === "usage")!;
		const subagent = getStatusBarSegments().find((s) => s.id === "subagent")!;
		expect(usage.formatValue(emptyCtx())).toBeNull();
		expect(subagent.formatValue(emptyCtx())).toBeNull();
	});

	it("usage formatValue includes the cache % so /current matches the status bar and web popover", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "usage")!;
		const usage = {
			promptTokens: 200_000,
			completionTokens: 50_000,
			totalTokens: 250_000,
			cost: 0,
			cacheReadTokens: 166_000,
			cacheWriteTokens: 0,
			uncachedTokens: 34_000,
			subagentTokens: 0,
		};
		expect(seg.formatValue(emptyCtx({ usage }))).toBe("200k in (83% cached) / 50k out");
	});

	it("cost formatValue renders dollars when cost is set and null otherwise", () => {
		const seg = getStatusBarSegments().find((s) => s.id === "cost")!;
		expect(seg.formatValue(emptyCtx())).toBeNull();
		const usage = {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cost: 0.25,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 100,
			subagentTokens: 0,
		};
		expect(seg.formatValue(emptyCtx({ usage }))).toBe("$0.25");
	});
});
