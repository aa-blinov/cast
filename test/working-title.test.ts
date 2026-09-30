import { describe, expect, it } from "vitest";
import { workingTitle } from "../src/ui/working-title.ts";

describe("workingTitle", () => {
	it("is an OSC 0 title with whole seconds", () => {
		expect(workingTitle(12_900)).toBe("\x1b]0;cast · working 12s\x07");
		expect(workingTitle(0)).toBe("\x1b]0;cast · working 0s\x07");
	});
});
