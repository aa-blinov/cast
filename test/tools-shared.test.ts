import { describe, expect, it } from "vitest";
import { completedToolCallStatus, normalizeToolResultError } from "../src/core/tools/shared.ts";

describe("completedToolCallStatus", () => {
	it("maps the canonical ToolResult error flag to the only terminal states", () => {
		expect(completedToolCallStatus()).toBe("ok");
		expect(completedToolCallStatus(false)).toBe("ok");
		expect(completedToolCallStatus(true)).toBe("error");
	});
});

describe("normalizeToolResultError", () => {
	it("adds stable metadata to legacy textual errors without changing their message", () => {
		const result = normalizeToolResultError({
			content: 'Error: "path" is required and must be a non-empty string.',
			isError: true,
		});
		expect(result.content).toBe('Error: "path" is required and must be a non-empty string.');
		expect(result.error).toEqual({
			code: "INVALID_ARGUMENT",
			retryable: false,
			suggestedFix: "Correct the tool name or arguments using the error details, then retry.",
		});
	});

	it("preserves explicit metadata supplied by a tool", () => {
		const error = { code: "ABORTED" as const, retryable: false, suggestedFix: "Do not retry." };
		expect(normalizeToolResultError({ content: "[ABORTED]", isError: true, error }).error).toBe(error);
	});

	it("preserves non-error result metadata while adding fallback error details", () => {
		expect(
			normalizeToolResultError({
				content: "File not found",
				isError: true,
				imageDataUrl: "data:image/png;base64,AA==",
			}),
		).toMatchObject({ imageDataUrl: "data:image/png;base64,AA==", error: { code: "NOT_FOUND" } });
	});
});
