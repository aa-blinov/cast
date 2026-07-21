import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printHelp } from "./core/help.ts";
import { runNonInteractive } from "./core/run.ts";
import { loadSettings } from "./core/settings.ts";
import type { ParsedArgs } from "./core/startup.ts";
import { runUpgrade } from "./core/upgrade.ts";
import { runTui } from "./ui/tui.tsx";

const VERSION: string = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
).version;

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args[0] === "upgrade") {
		const rest = args.slice(1);
		const force = rest.includes("--force");
		const pinnedVersion = rest.find((a) => a !== "--force");
		await runUpgrade(VERSION, pinnedVersion, force);
		return;
	}

	if (args[0] === "run") {
		await handleRunCommand(args.slice(1), VERSION);
		return;
	}

	if (args[0] === "web") {
		await handleWebCommand(args.slice(1));
		return;
	}

	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let initialPrompt: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let resumePicker = false;
	let cliBypassPermissions = false;
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--resume") {
			resumeRequested = true;
			resumePicker = true;
		} else if (args[i]?.startsWith("--resume=")) {
			resumeRequested = true;
			resumeId = args[i]!.slice("--resume=".length);
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			printHelp();
			return;
		} else if (args[i] === "--version" || args[i] === "-v") {
			console.log(`cast v${VERSION}`);
			return;
		} else {
			initialPrompt = args.slice(i).join(" ");
			break;
		}
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt,
		resumeRequested,
		resumeId,
		resumePicker,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		version: VERSION,
	};

	await runTui(parsedArgs);
}

async function handleRunCommand(args: string[], version: string): Promise<void> {
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");

	let cliModel: string | undefined;
	let cliReasoning: string | undefined;
	let cliPersona: string | undefined;
	let resumeRequested = false;
	let resumeId: string | undefined;
	let cliBypassPermissions = false;
	let format: "default" | "json" = "default";
	let noSkills = false;
	const cliSkillPaths: string[] = [];
	let noMcp = false;
	const cliMcpPaths: string[] = [];
	const messageParts: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--continue" || args[i] === "-c") {
			resumeRequested = true;
		} else if (args[i] === "--session" || args[i] === "-s") {
			resumeRequested = true;
			resumeId = args[i + 1];
			i++;
		} else if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--format") {
			const f = args[i + 1];
			if (f === "json") format = "json";
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		} else if (args[i] === "--skill") {
			const path = args[i + 1];
			if (path) cliSkillPaths.push(path);
			i++;
		} else if (args[i] === "--no-skills") {
			noSkills = true;
		} else if (args[i] === "--mcp") {
			const path = args[i + 1];
			if (path) cliMcpPaths.push(path);
			i++;
		} else if (args[i] === "--no-mcp") {
			noMcp = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`Usage: cast run [options] <message>

Options:
  -c, --continue         Continue the most recent session
  -s, --session <id>     Continue a specific session by ID
  -m, --model <model>    Model to use (provider/model)
  -r, --reasoning <lvl>  Reasoning level
  -p, --persona <name>   Persona to use
  --format <default|json>  Output format
  --bypass-permissions   Skip bash confirmation prompts`);
			return;
		} else {
			messageParts.push(...args.slice(i));
			break;
		}
	}

	const message = messageParts.join(" ").trim();
	if (!message) {
		console.error("Usage: cast run [options] <message>");
		console.error("Run 'cast run --help' for options.");
		process.exit(1);
	}

	const settings = loadSettings();

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested,
		resumeId,
		resumePicker: false,
		cliBypassPermissions,
		noSkills,
		cliSkillPaths,
		noMcp,
		cliMcpPaths,
		version,
	};

	await runNonInteractive(parsedArgs, { message, format });
}

async function handleWebCommand(args: string[]): Promise<void> {
	const PID_FILE = join(homedir(), ".cast", "web.pid");
	const LOG_FILE = join(homedir(), ".cast", "web.log");

	// Subcommands
	if (args[0] === "stop") {
		if (!existsSync(PID_FILE)) {
			console.log("[cast web] not running (no PID file)");
			return;
		}
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		try {
			process.kill(pid, "SIGTERM");
			console.log(`[cast web] stopped (pid ${pid})`);
		} catch {
			console.log(`[cast web] process ${pid} not found — cleaning up`);
		}
		try {
			unlinkSync(PID_FILE);
		} catch {
			/* ignore */
		}
		return;
	}

	if (args[0] === "status") {
		if (!existsSync(PID_FILE)) {
			console.log("[cast web] not running");
			return;
		}
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		try {
			process.kill(pid, 0); // signal 0 = check alive
			console.log(`[cast web] running (pid ${pid}) — http://localhost:${getPort(args)}`);
		} catch {
			console.log("[cast web] stale PID file — process not running");
			try {
				unlinkSync(PID_FILE);
			} catch {
				/* ignore */
			}
		}
		return;
	}

	// Determine mode: foreground or daemon
	const foreground = args.includes("--foreground");
	const port = getPort(args);
	const restArgs = args.filter((a) => a !== "--foreground" && a !== "start" && a !== "--port" && a !== String(port));

	if (foreground) {
		// Run inline (no daemon)
		const child = spawn(
			process.execPath,
			["--import", "tsx", "./src/web/index.ts", ...restArgs, "--port", String(port)],
			{
				cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
				stdio: "inherit",
				env: { ...process.env, CAST_CWD: process.cwd(), CAST_WEB_PORT: String(port) },
			},
		);
		child.on("exit", (code) => process.exit(code ?? 0));
		return;
	}

	// Daemon mode
	if (existsSync(PID_FILE)) {
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		try {
			process.kill(pid, 0);
			console.error(`[cast web] already running (pid ${pid}). Use 'cast web stop' first.`);
			process.exit(1);
		} catch {
			// Stale PID — clean up
			try {
				unlinkSync(PID_FILE);
			} catch {
				/* ignore */
			}
		}
	}

	const logFd = openSync(LOG_FILE, "a");
	const child = spawn(
		process.execPath,
		["--import", "tsx", "./src/web/index.ts", ...restArgs, "--port", String(port)],
		{
			cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: { ...process.env, CAST_CWD: process.cwd(), CAST_WEB_PORT: String(port) },
		},
	);

	child.unref();

	// Write PID
	writeFileSync(PID_FILE, String(child.pid), "utf-8");

	console.log(`[cast web] started (pid ${child.pid}) — http://localhost:${port}`);
	console.log(`[cast web] logs: ${LOG_FILE}`);
	console.log(`[cast web] stop: cast web stop`);
}

function getPort(args: string[]): number {
	const idx = args.indexOf("--port");
	if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1]!, 10);
	return parseInt(process.env.CAST_WEB_PORT ?? "3117", 10);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
