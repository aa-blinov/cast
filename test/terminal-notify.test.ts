import { afterEach, describe, expect, it } from "vitest";
import { notificationSequence, notifyTerminal, setTerminalFocused } from "../src/ui/terminal-notify.ts";

function sink() {
	const writes: string[] = [];
	return { writes, out: { write: (s: string) => writes.push(s) } as unknown as NodeJS.WritableStream };
}

describe("terminal notifications", () => {
	afterEach(() => setTerminalFocused(true));

	it("stays quiet while the terminal is focused, or never reported focus", () => {
		const { writes, out } = sink();
		expect(notifyTerminal("cast: turn done", out)).toBe(false);
		setTerminalFocused(false);
		setTerminalFocused(true);
		expect(notifyTerminal("cast: turn done", out)).toBe(false);
		expect(writes).toEqual([]);
	});

	it("notifies once the terminal reports it lost focus", () => {
		const { writes, out } = sink();
		setTerminalFocused(false);
		expect(notifyTerminal("cast: turn done", out)).toBe(true);
		expect(writes.join("")).toContain("cast: turn done");
		expect(writes.join("").endsWith("\x07")).toBe(true);
	});

	it("picks the sequence by terminal and wraps it for tmux", () => {
		expect(notificationSequence("hi", { TERM: "xterm-256color" })).toBe("\x1b]9;hi\x07\x07");
		expect(notificationSequence("hi", { TERM: "xterm-kitty" })).toBe("\x1b]99;;hi\x1b\\\x07");
		expect(notificationSequence("hi", { TERM: "foot" })).toBe("\x1b]777;notify;cast;hi\x1b\\\x07");
		expect(notificationSequence("hi", { TERM: "tmux-256color", TMUX: "/tmp/tmux" })).toBe(
			"\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\\x07",
		);
	});

	it("cannot be used to write escapes to the terminal", () => {
		const seq = notificationSequence("rm x\x07\x1b]0;pwned\x1b\\ ok", { TERM: "xterm" });
		expect(seq).toBe("\x1b]9;rm x ]0 pwned \\ ok\x07\x07");
	});
});
