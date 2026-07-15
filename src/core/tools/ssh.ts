import { spawn } from "node:child_process";
import type { AppConfig } from "../config.ts";
import { checkDangerousBash } from "../permissions.ts";
import {
	ensureControlDir,
	hasSshpass,
	registerControlDirCleanup,
	type SshHost,
	validateKeyPermissions,
} from "../ssh.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

/** Strip ANSI escape sequences from output. */
function stripAnsi(s: string): string {
	const ESC = String.fromCharCode(0x1b);
	const BEL = String.fromCharCode(0x07);
	// biome-ignore lint/suspicious/noUselessEscapeInString: [ must be escaped in regex
	const csi = new RegExp(`${ESC}\[[0-9;]*[a-zA-Z]`, "g");
	// biome-ignore lint/suspicious/noUselessEscapeInString: ] must be escaped in regex
	const osc = new RegExp(`${ESC}\][^${BEL}]*${BEL}`, "g");
	return s.replace(csi, "").replace(osc, "");
}

export async function execSsh(
	args: Record<string, unknown>,
	hosts: SshHost[],
	config: AppConfig,
	confirmBash?: ConfirmBash,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const hostName = String(args.host ?? "");
	const command = String(args.command ?? "");
	const timeout = typeof args.timeout === "number" ? args.timeout : config.defaultBashTimeout;

	// Validate host exists
	const hostMap = new Map(hosts.map((h) => [h.name, h]));
	const hostConfig = hostMap.get(hostName);
	if (!hostConfig) {
		const available = hosts.map((h) => h.name).join(", ");
		return {
			content: `Unknown SSH host: "${hostName}". Available hosts: ${available || "(none configured)"}`,
			isError: true,
		};
	}

	// Key validation
	if (hostConfig.keyPath) {
		const keyError = validateKeyPermissions(hostConfig.keyPath);
		if (keyError) return { content: keyError, isError: true };
	}

	// Dangerous command gating (unless host has dangerousCommands: "bypass")
	if (hostConfig.dangerousCommands !== "bypass" && confirmBash) {
		const dangerReason = checkDangerousBash(command);
		if (dangerReason && !(await confirmBash(command, dangerReason))) {
			return {
				content: `Blocked: command matches a dangerous pattern (${dangerReason}) and was not confirmed. Ask the user to run it manually, or use a safer alternative.`,
				isError: true,
			};
		}
	}

	if (signal?.aborted) {
		return { content: "[ABORTED] Command was interrupted by user (before execution started).", isError: true };
	}

	// Determine auth method: key takes priority over password
	const usePassword = !hostConfig.keyPath && !!hostConfig.password;
	if (usePassword && !hasSshpass()) {
		return {
			content:
				"sshpass is required for password-based SSH auth. Install it (apt install sshpass / brew install hudochenkov/sshpass/sshpass) or use keyPath instead.",
			isError: true,
		};
	}

	// Build SSH args
	const controlPath = ensureControlDir();
	registerControlDirCleanup();
	const target = hostConfig.username ? `${hostConfig.username}@${hostConfig.host}` : hostConfig.host;

	const sshArgs: string[] = [
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${controlPath}`,
		"-o",
		"ControlPersist=3600",
		"-o",
		"StrictHostKeyChecking=accept-new",
	];

	if (!usePassword) {
		sshArgs.push("-o", "BatchMode=yes");
	}
	sshArgs.push("-n");
	if (hostConfig.port) sshArgs.push("-p", String(hostConfig.port));
	if (hostConfig.keyPath) sshArgs.push("-i", hostConfig.keyPath);
	sshArgs.push(target, command);

	const spawnCmd = usePassword ? "sshpass" : "ssh";
	const spawnArgs = usePassword ? ["-e", "ssh", ...sshArgs] : sshArgs;
	const spawnEnv = usePassword && hostConfig.password ? { ...process.env, SSHPASS: hostConfig.password } : process.env;

	return new Promise<ToolResult>((resolve) => {
		const proc = spawn(spawnCmd, spawnArgs, {
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		let rawOutput = "";
		let timedOut = false;
		let aborted = false;
		const maxBytes = config.maxToolOutputBytes;

		proc.stdout.on("data", (d: Buffer) => {
			if (rawOutput.length < maxBytes) rawOutput += d.toString("utf-8");
		});
		proc.stderr.on("data", (d: Buffer) => {
			if (rawOutput.length < maxBytes) rawOutput += d.toString("utf-8");
		});

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				// already dead
			}
		}, timeout * 1000);

		const onAbort = () => {
			aborted = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				// already dead
			}
			setTimeout(() => {
				if (!finalResult)
					resolve({
						content: "[ABORTED] Command was interrupted by user (forced — process did not exit).",
						isError: true,
					});
			}, 5000);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let finalResult: ToolResult | null = null;

		proc.on("close", (exitCode) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);

			let output = stripAnsi(rawOutput).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			const prefix = aborted
				? "[ABORTED] Command was interrupted by user.\n\n"
				: timedOut
					? `[TIMED OUT] after ${timeout} seconds. If this command needs more time, retry with a larger timeout.\n\n`
					: "";
			if (exitCode !== 0 && !aborted && !timedOut) {
				output += `\n\nProcess exited with code ${exitCode}`;
			}
			const lines = output.split("\n");
			if (lines.length > config.maxToolOutputLines) {
				const kept = lines.slice(-config.maxToolOutputLines);
				output = `[Showing last ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`;
			}
			const result: ToolResult = {
				content: prefix + (output || "(no output)"),
				isError: aborted || timedOut || exitCode !== 0,
			};
			finalResult = result;
			resolve(result);
		});
	});
}
