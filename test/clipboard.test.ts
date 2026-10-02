import { describe, expect, it } from "vitest";
import { copyToClipboard } from "../src/ui/clipboard.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("copyToClipboard", () => {
	it("uses the platform's tool, and says it was confirmed", () => {
		const ran: string[] = [];
		const run = (command: string) => {
			ran.push(command);
			return true;
		};
		expect(copyToClipboard("hi", { platform: "darwin", env: {}, run })).toEqual({
			ok: true,
			via: "pbcopy",
			verified: true,
		});
		expect(ran).toEqual(["pbcopy"]);
	});

	it("tries wl-copy on Wayland, then xclip, then xsel, and stops at the first that works", () => {
		const ran: string[] = [];
		const run = (command: string) => {
			ran.push(command);
			return command === "xsel";
		};
		const result = copyToClipboard("hi", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, run });
		expect(ran).toEqual(["wl-copy", "xclip", "xsel"]);
		expect(result).toEqual({ ok: true, via: "xsel", verified: true });
	});

	it("falls back to the terminal on Linux when no tool is installed, and says it cannot confirm", () => {
		const written: string[] = [];
		const result = copyToClipboard("héllo", {
			platform: "linux",
			env: {},
			run: () => false,
			write: (s) => written.push(s),
		});
		expect(result).toMatchObject({ ok: true, verified: false });
		expect(written).toEqual([`${ESC}]52;c;${Buffer.from("héllo").toString("base64")}${BEL}`]);
	});

	it("over SSH asks the terminal at once, since a local tool would fill the remote machine's clipboard", () => {
		const ran: string[] = [];
		const written: string[] = [];
		const result = copyToClipboard("hi", {
			platform: "linux",
			env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22", DISPLAY: ":0" },
			run: (command) => (ran.push(command), true),
			write: (s) => written.push(s),
		});
		expect(ran).toEqual([]);
		expect(written).toHaveLength(1);
		expect(result).toMatchObject({ ok: true, verified: false });
	});

	it("fails honestly on macOS or Windows when the tool fails", () => {
		expect(copyToClipboard("hi", { platform: "win32", env: {}, run: () => false })).toEqual({
			ok: false,
			error: "clip failed",
		});
	});
});
