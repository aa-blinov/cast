/**
 * `parseInteractiveAction` — JSONL protocol for `cast run --interactive`.
 * Unit-test only the parser; end-to-end coverage of the `command` action
 * against the live runner needs an external HTTP probe and a network
 * sandbox that the local vitest environment can't satisfy.
 */
import { describe, expect, it } from "vitest";
import { parseInteractiveAction } from "../src/core/run.ts";

describe("parseInteractiveAction — command action", () => {
	it("parses a bare command name with empty args", () => {
		expect(parseInteractiveAction('{"type":"command","name":"worktree","args":""}')).toEqual({
			type: "command",
			name: "worktree",
			args: "",
		});
	});

	it("parses a command with leading-space args (the handleInput wire shape)", () => {
		expect(parseInteractiveAction('{"type":"command","name":"worktree","args":" feature-1"}')).toEqual({
			type: "command",
			name: "worktree",
			args: " feature-1",
		});
	});

	it("rejects empty command name", () => {
		expect(() => parseInteractiveAction('{"type":"command","name":"","args":""}')).toThrow(
			/command\.name must be a non-empty string/,
		);
	});

	it("rejects missing command name", () => {
		expect(() => parseInteractiveAction('{"type":"command","args":"foo"}')).toThrow(
			/command\.name must be a non-empty string/,
		);
	});

	it("rejects non-string command name", () => {
		expect(() => parseInteractiveAction('{"type":"command","name":42,"args":""}')).toThrow(
			/command\.name must be a non-empty string/,
		);
	});

	it("rejects non-string args", () => {
		expect(() => parseInteractiveAction('{"type":"command","name":"worktree","args":42}')).toThrow(
			/command\.args must be a string/,
		);
	});

	it("preserves multi-word args verbatim (including leading space)", () => {
		// `handleInput` slices the leading space off to recover the verb
		// ("/worktree") and the remainder (" feature-1"). Round-tripping the
		// original wire form is what makes the protocol usable.
		const action = parseInteractiveAction('{"type":"command","name":"persona","args":" coder-with-subagents"}');
		expect(action).toEqual({ type: "command", name: "persona", args: " coder-with-subagents" });
	});
});

describe("parseInteractiveAction — pre-existing actions still parse", () => {
	it("prompt", () => {
		expect(parseInteractiveAction('{"type":"prompt","text":"hello"}')).toEqual({
			type: "prompt",
			text: "hello",
		});
	});

	it("set_mode plan", () => {
		expect(parseInteractiveAction('{"type":"set_mode","mode":"plan"}')).toEqual({
			type: "set_mode",
			mode: "plan",
		});
	});

	it("state", () => {
		expect(parseInteractiveAction('{"type":"state"}')).toEqual({ type: "state" });
	});

	it("exit", () => {
		expect(parseInteractiveAction('{"type":"exit"}')).toEqual({ type: "exit" });
	});

	it("rejects unknown action type", () => {
		expect(() => parseInteractiveAction('{"type":"wat"}')).toThrow(/unknown action type/);
	});

	it("rejects action without type", () => {
		expect(() => parseInteractiveAction("{}")).toThrow(/action\.type is required/);
	});

	it("rejects non-JSON", () => {
		expect(() => parseInteractiveAction("not json")).toThrow();
	});
});
