import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../src/ui/markdown-terminal.ts";
import { toAscii } from "../src/ui-pi/ascii.ts";
import { messageLines, toolRowLines } from "../src/ui-pi/lines.ts";
import { sanitize } from "../src/ui-pi/sanitize.ts";
import { Transcript } from "../src/ui-pi/transcript.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const options = { width: 46, showReasoning: false };

describe("sanitize", () => {
	it("removes the sequences a terminal would obey: CSI, OSC to BEL or ST, DCS, and a lone escape", () => {
		expect(sanitize(`${ESC}[2Jhello`)).toBe("hello");
		expect(sanitize(`a${ESC}]52;c;AAAA${BEL}b`)).toBe("ab");
		expect(sanitize(`a${ESC}]0;title${ESC}\\b`)).toBe("ab");
		expect(sanitize(`a${ESC}Pq#0${ESC}\\b`)).toBe("ab");
		expect(sanitize(`a${ESC}Mb`)).toBe("ab");
		expect(sanitize(`x${String.fromCharCode(0x9b)}2Jy`)).toBe("xy");
	});

	it("drops other control characters, makes carriage returns line breaks, and gives tabs their width", () => {
		expect(sanitize(`a${String.fromCharCode(0)}${String.fromCharCode(8)}b${String.fromCharCode(127)}`)).toBe("ab");
		expect(sanitize("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
		expect(sanitize("\tfoo")).toBe("    foo");
	});

	it("leaves ordinary text, line breaks and non-Latin scripts alone", () => {
		const text = "Привет, мир\n  indented `code` — 日本語 ✓";
		expect(sanitize(text)).toBe(text);
	});
});

describe("what reaches the screen", () => {
	const rowsOf = (lines: string[]) => lines.join("\n");
	it("carries no escape sequence from a message, a block or a tool row", () => {
		const hostile = `x${ESC}[2J${ESC}]52;c;AAAA${BEL}y`;
		const rows = [
			...messageLines({ role: "user", content: hostile }, options),
			...messageLines({ role: "assistant", content: "", blocks: [{ kind: "content", text: hostile }] }, options),
			...messageLines({ role: "warning", content: hostile }, options),
			...toolRowLines({ id: "1", name: "bash", args: JSON.stringify({ command: hostile }), status: "ok" }, 60),
		];
		// Our own colour codes are fine; nothing else with an escape in it is.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: looking for any escape that is not a colour
		expect(rowsOf(rows)).not.toMatch(/\x1b(?!\[[0-9;]*m)/);
		expect(rowsOf(rows)).not.toContain(BEL);
	});

	it("keeps a finished multi-line command on one row under its margin", () => {
		const rows = toolRowLines(
			{ id: "1", name: "bash", args: JSON.stringify({ command: "echo a\n\techo b\nls" }), status: "ok" },
			60,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("\t");
	});
});

describe("messages of an unexpected shape", () => {
	it("do not throw: a missing content, an unknown block kind, a block without text", () => {
		expect(() => messageLines({ role: "user" } as never, options)).not.toThrow();
		expect(() =>
			messageLines(
				{ role: "assistant", content: "", blocks: [{ kind: "image" }, { kind: "content" }] } as never,
				options,
			),
		).not.toThrow();
		expect(() => toolRowLines({ id: "1", name: "edit", status: "ok" } as never, 40)).not.toThrow();
	});

	it("shows one quiet row for a message that still cannot be laid out, and the rest of the frame", () => {
		const transcript = new Transcript();
		const broken = {
			role: "assistant",
			content: "",
			get blocks(): never {
				throw new Error("boom");
			},
		};
		transcript.set({
			messages: [{ role: "user", content: "hi" }, broken as never, { role: "user", content: "after" }],
			streaming: null,
			error: null,
			retry: null,
			showReasoning: false,
		});
		const text = transcript.render(60).join("\n");
		expect(text).toContain("could not be shown: boom");
		expect(text).toContain("after");
	});
});

describe("very large input", () => {
	it("a message of hundreds of thousands of rows renders without overflowing the stack", () => {
		const rows = messageLines({ role: "user", content: "x\n".repeat(300_000) }, options);
		expect(rows.length).toBeGreaterThan(300_000);
		const transcript = new Transcript();
		transcript.set({
			messages: [{ role: "user", content: "x\n".repeat(300_000) }],
			streaming: null,
			error: null,
			retry: null,
			showReasoning: false,
		});
		expect(transcript.render(60).length).toBeGreaterThan(300_000);
	});

	it("a table of two hundred thousand rows renders", () => {
		const rows = renderMarkdownLines(`${"|a|b|\n".repeat(200_000)}`, { width: 60 });
		expect(rows.length).toBeGreaterThan(1000);
	});
});

describe("tables and headings in a narrow width", () => {
	it("a table with more columns than the width can hold is set as rows, within the width", () => {
		const header = `|${Array.from({ length: 10 }, (_, i) => `h${i}`).join("|")}|`;
		const rule = `|${Array.from({ length: 10 }, () => "---").join("|")}|`;
		const row = `|${Array.from({ length: 10 }, (_, i) => `c${i}`).join("|")}|`;
		for (const width of [30, 46]) {
			const rows = renderMarkdownLines(`${header}\n${rule}\n${row}`, { width });
			for (const line of rows) {
				const text = line.spans.map((span) => span.text).join("");
				expect(visibleWidth(text), text).toBeLessThanOrEqual(width);
			}
		}
	});

	it("a long word under a heading is split to the narrower line a hanging indent leaves", () => {
		const rows = renderMarkdownLines(`# aaa ${"b".repeat(41)}`, { width: 46 });
		for (const line of rows) {
			const text = line.spans.map((span) => span.text).join("");
			expect(visibleWidth(text), text).toBeLessThanOrEqual(46);
		}
	});
});

describe("ASCII mode", () => {
	it("has an answer for the minus sign the edit rows use", () => {
		expect(toAscii("−3")).toBe("-3");
	});
});
