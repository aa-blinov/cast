import { describe, expect, it } from "vitest";
import { completedToolCallStatus } from "../src/core/tools/shared.ts";

describe("completedToolCallStatus", () => {
	it("maps the canonical ToolResult error flag to the only terminal states", () => {
		expect(completedToolCallStatus()).toBe("ok");
		expect(completedToolCallStatus(false)).toBe("ok");
		expect(completedToolCallStatus(true)).toBe("error");
	});
});
