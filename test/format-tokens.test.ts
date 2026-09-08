import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { abbreviateTokens, formatContextPct, shouldReprintBanner } from "../src/ui/App.tsx";

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
		// Denominator is the budget: half of 32,768 once the reserve is capped.
		expect(formatContextPct([], cfg(32_768, 32_000))).toMatch(/^ctx .+\/16\.4k \(\d+%\)$/);
	});

	it("formats used/budget with a percentage when there is a budget", () => {
		const out = formatContextPct([], cfg(200_000, 8000));
		expect(out).toMatch(/^ctx \d[\d.]*[kM]?\/192k \(\d+%\)$/);
	});

	it("shows a fraction that agrees with its own percentage", () => {
		// Both halves used to come from different denominators: a 128k model with
		// the default reserve printed "ctx 94.7k/128k (99%)" — 94.7/128 is 74%.
		const messages = [{ role: "user" as const, content: "x".repeat(360_000) }];
		const out = formatContextPct(messages, cfg(128_000, 32_000));

		const match = /^ctx ([\d.]+)k\/([\d.]+)k \((\d+)%\)$/.exec(out);
		expect(match, out).not.toBeNull();
		const [, used, budget, pct] = match!;
		const impliedPct = Math.round((Number(used) / Number(budget)) * 100);
		expect(Math.abs(impliedPct - Number(pct))).toBeLessThanOrEqual(1);
	});
});

describe("shouldReprintBanner", () => {
	/**
	 * The banner is written outside Ink's tree, so a clear erases it. A light
	 * resync keeps the scrollback, so reprinting there left the old copy above
	 * and added another below — once per resync. Three resizes, three extra
	 * banners (reproduced in a pseudo-terminal).
	 */
	it("reprints on a full resync, which wipes the old copy with the scrollback", () => {
		expect(shouldReprintBanner(false, 0)).toBe(true);
		expect(shouldReprintBanner(false, 12)).toBe(true);
	});

	it("reprints on a light resync only while the banner is what is on screen", () => {
		expect(shouldReprintBanner(true, 0)).toBe(true);
		expect(shouldReprintBanner(true, 1)).toBe(false);
		expect(shouldReprintBanner(true, 200)).toBe(false);
	});
});
