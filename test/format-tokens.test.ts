import { describe, expect, it } from "vitest";
import { abbreviateTokens } from "../src/ui/format-tokens.ts";

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
