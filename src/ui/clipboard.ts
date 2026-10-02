import { spawnSync } from "node:child_process";

export type CopyResult = { ok: true; via: string; verified: boolean } | { ok: false; error: string };

interface CopyDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Runs a clipboard program with the text on its stdin; true when it exited cleanly. */
	run?: (command: string, args: string[], input: string | Buffer) => boolean;
	/** Writes to the terminal (OSC 52). */
	write?: (text: string) => void;
}

const defaultRun = (command: string, args: string[], input: string | Buffer): boolean => {
	const result = spawnSync(command, args, { input, stdio: ["pipe", "ignore", "ignore"], timeout: 3000 });
	return !result.error && result.status === 0;
};

/**
 * Puts text on the clipboard, by whatever the machine has. Over SSH a local tool would fill the remote machine's
 * clipboard, so the terminal is asked instead (OSC 52); that cannot be confirmed, which the result says.
 */
export function copyToClipboard(text: string, deps: CopyDeps = {}): CopyResult {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const run = deps.run ?? defaultRun;
	const write = deps.write ?? ((s: string) => void process.stdout.write(s));
	const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
	const viaTerminal = (): CopyResult => {
		write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return { ok: true, via: "the terminal (OSC 52)", verified: false };
	};
	if (remote) return viaTerminal();

	const tried: Array<[string, string[], string | Buffer]> = [];
	if (platform === "darwin") tried.push(["pbcopy", [], text]);
	else if (platform === "win32") tried.push(["clip", [], Buffer.from(text, "utf-16le")]);
	else {
		if (env.WAYLAND_DISPLAY) tried.push(["wl-copy", [], text]);
		tried.push(["xclip", ["-selection", "clipboard"], text], ["xsel", ["--clipboard", "--input"], text]);
	}
	for (const [command, args, input] of tried) {
		if (run(command, args, input)) return { ok: true, via: command, verified: true };
	}
	// No tool worked: the terminal may still take it.
	if (platform !== "darwin" && platform !== "win32") return viaTerminal();
	return { ok: false, error: `${tried[0]?.[0] ?? "the clipboard tool"} failed` };
}
