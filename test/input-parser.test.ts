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

	it("ignores an unrecognized control byte (< 32, no binding)", () => {
		const { events, feed } = makeParser();
		feed("\x00");
		expect(events).toEqual([]);
	});
});
