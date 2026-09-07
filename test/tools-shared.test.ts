import { describe, expect, it } from "vitest";
import { BoundedOutput, completedToolCallStatus, normalizeToolResultError } from "../src/core/tools/shared.ts";

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

describe("BoundedOutput", () => {
	it("keeps a multibyte character split across two chunks intact (regression)", () => {
		// Each chunk used to be decoded on its own, so a character straddling a
		// pipe-chunk boundary became U+FFFD. Measured on `cat` of a file with an
		// emoji astride each 64KB boundary: all five destroyed, 15 replacement
		// characters in the output the model reads. Any non-ASCII text in a
		// large command output was corrupted this way.
		const emoji = Buffer.from("\u{1F3AF}", "utf8");
		const out = new BoundedOutput(1000);
		out.append(emoji.subarray(0, 2));
		out.append(emoji.subarray(2));
		expect(out.final()).toBe("\u{1F3AF}");
		expect(out.truncated).toBe(false);
	});

	it("counts bytes, not characters, against the budget", () => {
		const out = new BoundedOutput(4);
		out.append(Buffer.from("\u{1F3AF}", "utf8")); // exactly 4 bytes
		expect(out.final()).toBe("\u{1F3AF}");
		expect(out.truncated).toBe(false);
		out.append(Buffer.from("a"));
		expect(out.truncated).toBe(true);
		expect(out.final()).toBe("\u{1F3AF}");
	});

	it("marks truncation and does not emit a stray replacement char at the cut", () => {
		// The cut lands inside a 4-byte character; the decoder holds the partial
		// sequence and renders it once on flush rather than mid-text.
		const out = new BoundedOutput(6);
		out.append(Buffer.concat([Buffer.from("abcd"), Buffer.from("\u{1F3AF}", "utf8")]));
		expect(out.truncated).toBe(true);
		expect(out.final().startsWith("abcd")).toBe(true);
		expect(out.final().length).toBeLessThanOrEqual(6);
	});

	it("accepts strings as well as buffers (the pty path)", () => {
		const out = new BoundedOutput(100);
		out.append("привет ");
		out.append("мир");
		expect(out.final()).toBe("привет мир");
	});

	it("is safe to read repeatedly, and a snapshot never flushes a partial character", () => {
		const out = new BoundedOutput(100);
		out.append(Buffer.from("one "));
		expect(out.final()).toBe("one ");
		expect(out.final()).toBe("one ");

		// A live background task reads between chunks: a snapshot must not turn
		// the half-received character into U+FFFD.
		const emoji = Buffer.from("\u{1F3AF}", "utf8");
		const live = new BoundedOutput(100);
		live.append(Buffer.from("x"));
		live.append(emoji.subarray(0, 2));
		expect(live.snapshot()).toBe("x");
		live.append(emoji.subarray(2));
		expect(live.snapshot()).toBe("x\u{1F3AF}");
	});
});
