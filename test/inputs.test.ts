import { describe, expect, it } from "vitest";
import { sessionInputsDir } from "../src/web/inputs.ts";

describe("sessionInputsDir", () => {
	it("is keyed by session id, not by cwd — a stable location regardless of where the session runs", () => {
		const a = sessionInputsDir("session-aaa");
		const b = sessionInputsDir("session-bbb");
		expect(a).not.toBe(b);
		expect(a).toContain("session-aaa");
		expect(a).toContain(".cast");
		expect(a).toContain("inputs");
	});

	it("is deterministic for the same session id", () => {
		expect(sessionInputsDir("same-id")).toBe(sessionInputsDir("same-id"));
	});
});
