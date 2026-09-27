/**
 * "Look over here" for the TUI: a desktop notification through the terminal
 * (OSC 9 / 99 / 777) plus a bell, sent only while the terminal window is out
 * of focus. Focus comes from the terminal's own reports (DEC mode 1004); a
 * terminal that never sends one is treated as focused, so a user watching the
 * turn is never beeped at.
 */

import { loadSettings } from "../core/settings.ts";

export const FOCUS_REPORTING_ON = "\x1b[?1004h";
export const FOCUS_REPORTING_OFF = "\x1b[?1004l";

let focused = true;

export function setTerminalFocused(value: boolean): void {
	focused = value;
}

/** The escape sequence for one notification, picked by terminal. */
export function notificationSequence(message: string, env: NodeJS.ProcessEnv = process.env): string {
	// The text is partly model-written (a command awaiting approval): no
	// control characters, or it could end the OSC and write to the terminal.
	// Semicolons separate OSC 777's fields.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const text = message.replace(/[\x00-\x1f\x7f-\x9f;]+/g, " ").slice(0, 200);
	const term = env.TERM ?? "";
	let osc: string;
	if (term === "xterm-kitty") osc = `\x1b]99;;${text}\x1b\\`;
	else if (term.startsWith("foot") || term.startsWith("rxvt")) osc = `\x1b]777;notify;cast;${text}\x1b\\`;
	else osc = `\x1b]9;${text}\x07`;
	// tmux swallows an OSC it doesn't know unless it's wrapped for passthrough
	// (and `allow-passthrough on`); the bell after it gets through either way.
	if (env.TMUX) osc = `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
	return `${osc}\x07`;
}

/** Notify when the terminal is unfocused and notifications aren't turned off. */
export function notifyTerminal(message: string, out: NodeJS.WritableStream = process.stderr): boolean {
	if (focused || loadSettings().notifications === false) return false;
	out.write(notificationSequence(message));
	return true;
}

export function turnEndNotice(reason: string): string {
	return reason === "stop" ? "cast: turn done" : `cast: turn ended (${reason})`;
}
