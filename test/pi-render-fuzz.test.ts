import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { messageLines } from "../src/ui-pi/lines.ts";

// A seeded generator: the same documents every run, so a failure is the same failure.
let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)] as T;
const WORDS = [
	"alpha",
	"b",
	"Привет",
	"日本語のテキスト",
	"😀",
	"👨‍👩‍👧",
	"é",
	"https://example.com/a/very/long/path/that/never/breaks/at/all?x=1&y=2",
	"`code`",
	"**bold**",
	"_it_",
	"[link](http://x.y/z)",
	"x".repeat(70),
	"─".repeat(30),
	"—",
	"…",
	"​",
	"<b>tag</b>",
	"|",
	"*",
	"#",
	">",
	"1.",
];
const line = () => Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pick(WORDS)).join(rnd() < 0.8 ? " " : "");

function block(): string {
	const kind = rnd();
	if (kind < 0.18) return `${"#".repeat(1 + Math.floor(rnd() * 4))} ${line()}`;
	if (kind < 0.34) {
		return Array.from(
			{ length: 1 + Math.floor(rnd() * 5) },
			(_, i) => `${"  ".repeat(Math.floor(rnd() * 3))}${rnd() < 0.5 ? "-" : `${i + 1}.`} ${line()}`,
		).join("\n");
	}
	if (kind < 0.46) {
		const body = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => `${pick(["", "\t", "    "])}${line()}`);
		return `\`\`\`${pick(["", "ts", "go", "sh"])}\n${body.join("\n")}\n${rnd() < 0.8 ? "```" : ""}`;
	}
	if (kind < 0.58) {
		const columns = 1 + Math.floor(rnd() * 8);
		const row = () => `|${Array.from({ length: columns }, () => pick(WORDS)).join("|")}|`;
		return `${row()}\n|${Array.from({ length: columns }, () => "---").join("|")}|\n${row()}\n${row()}`;
	}
	if (kind < 0.66) return `> ${line()}\n> ${line()}`;
	if (kind < 0.72) return "---";
	if (kind < 0.78) return `- [${rnd() < 0.5 ? "x" : " "}] ${line()}`;
	return line();
}

describe("rendering random markdown", () => {
	it("never makes a row wider than the width, and never throws, from 24 columns up", () => {
		const failures: string[] = [];
		for (let n = 0; n < 600 && failures.length < 3; n++) {
			const text = Array.from({ length: 1 + Math.floor(rnd() * 6) }, block).join(rnd() < 0.5 ? "\n\n" : "\n");
			const width = pick([24, 30, 40, 46, 60, 80, 100, 120, 160]);
			for (const message of [
				{ role: "assistant", content: "", blocks: [{ kind: "content", text }] },
				{ role: "user", content: text },
				{ role: "warning", content: text },
			]) {
				for (const row of messageLines(message as never, { width, showReasoning: true })) {
					if (visibleWidth(row) > width) {
						failures.push(`width ${width}, row ${visibleWidth(row)}: ${JSON.stringify(text).slice(0, 200)}`);
						break;
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
