import { afterEach, describe, expect, it } from "vitest";
import { reduceMotion } from "../src/ui/animation-clock.ts";

const saved = process.env.CAST_REDUCE_MOTION;
afterEach(() => {
	if (saved === undefined) delete process.env.CAST_REDUCE_MOTION;
	else process.env.CAST_REDUCE_MOTION = saved;
});

describe("reduceMotion", () => {
	it("follows CAST_REDUCE_MOTION, where 0 and empty mean off", () => {
		process.env.CAST_REDUCE_MOTION = "1";
		expect(reduceMotion()).toBe(true);
		process.env.CAST_REDUCE_MOTION = "0";
		expect(reduceMotion()).toBe(false);
	});
});
