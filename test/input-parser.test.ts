import { describe, expect, it } from "vitest";
import { type InputEvent, InputParser } from "../src/ui/input/input-parser.ts";
import { StdinBuffer } from "../src/ui/input/stdin-buffer.ts";

// Inject completed sequences straight onto the buffer's "data" channel, which
// is exactly what StdinBuffer emits once a sequence is complete — this exercises
// InputParser's binding/printable classification without StdinBuffer's paste /
// incomplete-escape timers getting in the way.
function makeParser() {
	const events: InputEvent[] = [];
	const buffer = new StdinBuffer();
	const parser = new InputParser((e) => events.push(e), buffer);
	const feed = (sequence: string) => buffer.emit("data", sequence);
	return { events, feed, parser };
}

describe("InputParser — sequence classification", () => {
	it("maps Ctrl+C to the input.abort binding", () => {
		const { events, feed } = makeParser();
		feed("\x03");
		expect(events).toEqual([{ type: "binding", binding: "input.abort", raw: "\x03" }]);
	});

	it("maps Esc to the input.escape binding", () => {
		const { events, feed } = makeParser();
		feed("\x1b");
		expect(events).toEqual([{ type: "binding", binding: "input.escape", raw: "\x1b" }]);
	});

	it("emits a printable ASCII char as a char event", () => {
		const { events, feed } = makeParser();
		feed("a");
		expect(events).toEqual([{ type: "char", text: "a" }]);
	});

	it("emits a single non-ASCII printable (Cyrillic) as a char event", () => {
		const { events, feed } = makeParser();
		feed("и");
		expect(events).toEqual([{ type: "char", text: "и" }]);
	});

	it("drops focus in/out reports (CSI I / CSI O) — never surfaced as input", () => {
		const { events, feed } = makeParser();
		feed("\x1b[I");
		feed("\x1b[O");
		expect(events).toEqual([]);
	});

	it("drops DECXCPR cursor-position responses (CSI row;col R)", () => {
		const { events, feed } = makeParser();
		feed("\x1b[12;40R");
		feed("\x1b[1;1R");
		expect(events).toEqual([]);
	});

	it("ignores an unrecognized control byte (< 32, no binding)", () => {
		const { events, feed } = makeParser();
		feed("\x00");
		expect(events).toEqual([]);
	});
});

describe("InputParser — submit-only Enter (no newline binding)", () => {
	it("maps Enter (\\r) to input.submit", () => {
		const { events, feed } = makeParser();
		feed("\r");
		expect(events).toEqual([{ type: "binding", binding: "input.submit", raw: "\r" }]);
	});

	it("ignores Kitty Shift+Enter (CSI 13;2u) — no binding claims it", () => {
		const { events, feed } = makeParser();
		feed("\x1b[13;2u");
		expect(events).toEqual([]);
	});

	it("ignores modifyOtherKeys Shift+Enter", () => {
		const { events, feed } = makeParser();
		feed("\x1b[27;2;13~");
		expect(events).toEqual([]);
	});

	it("ignores legacy Alt+Enter (\\x1b\\r)", () => {
		const { events, feed } = makeParser();
		feed("\x1b\r");
		expect(events).toEqual([]);
	});

	it("maps legacy Ctrl+J (\\n) to input.submit, same as Enter", () => {
		// With no newline binding to shadow it, the "enter" matcher's \n arm
		// (for terminals without the Kitty protocol) wins — Ctrl+J submits.
		const { events, feed } = makeParser();
		feed("\n");
		expect(events).toEqual([{ type: "binding", binding: "input.submit", raw: "\n" }]);
	});
});
