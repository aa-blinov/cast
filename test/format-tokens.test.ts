import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { abbreviateTokens, formatContextPct } from "../src/ui/App.tsx";

describe("abbreviateTokens", () => {
	it("leaves values under 1000 untouched", () => {
		expect(abbreviateTokens(0)).toBe("0");
		expect(abbreviateTokens(736)).toBe("736");
		expect(abbreviateTokens(999)).toBe("999");
	});

	it("uses k with one decimal, dropping a trailing .0", () => {
		expect(abbreviateTokens(1000)).toBe("1k");
		expect(abbreviateTokens(8000)).toBe("8k");
		expect(abbreviateTokens(8736)).toBe("8.7k");
		expect(abbreviateTokens(999_949)).toBe("999.9k");
	});

	it("hands 999,950+ to the M branch so it reads 1M, not 1000k", () => {
		expect(abbreviateTokens(999_950)).toBe("1M");
		expect(abbreviateTokens(1_000_000)).toBe("1M");
		expect(abbreviateTokens(1_200_000)).toBe("1.2M");
	});
});

describe("formatContextPct", () => {
	const cfg = (contextWindow: number, maxResponseTokens: number) =>
		({ contextWindow, maxResponseTokens }) as unknown as AppConfig;

	it("returns 'ctx ?' only when the window itself is unusable", () => {
		expect(formatContextPct([], cfg(0, 100))).toBe("ctx ?");
		expect(formatContextPct([], cfg(Number.NaN, 100))).toBe("ctx ?");
	});

	it("still reports a percentage when the reply reserve exceeds the window", () => {
		// It used to print "ctx ?" here, because the reserve was subtracted raw
		// and the budget went non-positive — the ordinary case for a 32k model
		// with the default 32k reserve. The reserve is now capped at half the
		// window, so there is always a real budget to show.
		expect(formatContextPct([], cfg(32_768, 32_000))).toMatch(/^ctx .+\/32\.8k \(\d+%\)$/);
	});

	it("formats used/window with a percentage when there is a budget", () => {
		const out = formatContextPct([], cfg(200_000, 8000));
		expect(out).toMatch(/^ctx \d[\d.]*[kM]?\/200k \(\d+%\)$/);
	});
});
