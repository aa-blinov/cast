import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { defaultStatusBarConfig, type SegmentContext } from "../src/ui/statusbar.ts";
import { statusLine } from "../src/ui-pi/status.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const ctx: SegmentContext = {
	persona: "Senior Developer",
	planMode: false,
	activeModel: "mock-model",
	configuredModel: "mock-model",
	planModel: undefined,
	usage: undefined,
	lastTurnUsage: undefined,
	elapsedMs: 41_900,
	messageCount: 4,
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	messages: [],
	sessionId: "abc",
};

describe("statusLine", () => {
	it("joins the left group and then the elapsed time with ` * ` in one row, without padding to the edge", () => {
		const line = plain(statusLine(ctx, defaultStatusBarConfig(), 100));
		expect(line).toBe("Senior Developer * BUILD * mock-model * 41s");
		expect(visibleWidth(line)).toBeLessThan(100);
	});

	it("drops whole segments, least useful first, rather than cutting one in half", () => {
		const narrow = plain(statusLine(ctx, defaultStatusBarConfig(), 40));
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
		expect(narrow).toContain("mock-model");
		expect(narrow).not.toContain("Senior Devel…");
	});

	it("shows the data-driven segments once they are switched on and there is data", () => {
		const config = {
			...defaultStatusBarConfig(),
			visible: ["persona", "context", "usage", "speed", "elapsed"],
		};
		const withData: SegmentContext = {
			...ctx,
			messages: [{ role: "user", content: "hello there" }],
			usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cost: 0.02 } as SegmentContext["usage"],
			lastTurnUsage: { tokensPerSecond: 42 },
		};
		const line = plain(statusLine(withData, config, 140));
		expect(line).toMatch(/ctx \S+\/\S+ \(\d+%\)/);
		expect(line).toContain("42");
		expect(line).toContain("41s");
		expect(plain(statusLine(ctx, config, 140))).not.toContain("ctx");
	});

	it("marks plan mode", () => {
		expect(plain(statusLine({ ...ctx, planMode: true }, defaultStatusBarConfig(), 100))).toContain("PLAN");
	});

	it("turns the context figure amber at 70% and red at 90% of the budget", () => {
		const config = { ...defaultStatusBarConfig(), visible: ["context"] };
		const big = (chars: number) => ({
			...ctx,
			contextWindow: 10_000,
			messages: [{ role: "user", content: "x".repeat(chars) }] as never,
		});
		const calm = statusLine(big(4_000), config, 60);
		const warm = statusLine(big(26_000), config, 60);
		const hot = statusLine(big(40_000), config, 60);
		expect(new Set([calm, warm, hot]).size).toBe(3);
		expect(plain(hot)).toContain("ctx");
	});
});
