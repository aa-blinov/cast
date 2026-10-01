import { describe, expect, it } from "vitest";
import { dots, withoutDots } from "../src/ui-pi/dots.ts";

describe("dots", () => {
	it("runs . then .. then ... and starts again, padded to three cells", () => {
		const at = (step: number) => dots(step * 400);
		expect([at(0), at(1), at(2), at(3), at(4)]).toEqual([".  ", ".. ", "...", ".  ", ".. "]);
		for (let step = 0; step < 6; step++) expect(at(step)).toHaveLength(3);
	});

	it("holds a step for 400ms rather than flickering with every redraw", () => {
		expect(dots(1000)).toBe(dots(1100));
	});
});

describe("withoutDots", () => {
	it("takes off the dots a label was written with, three dots or an ellipsis, and nothing else", () => {
		expect(withoutDots("Connecting to model...")).toBe("Connecting to model");
		expect(withoutDots("Loading models…")).toBe("Loading models");
		expect(withoutDots("Starting cast")).toBe("Starting cast");
		expect(withoutDots("Version 1.2 is out")).toBe("Version 1.2 is out");
	});
});
