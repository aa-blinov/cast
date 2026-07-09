import { readFileSync } from "node:fs";
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

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
