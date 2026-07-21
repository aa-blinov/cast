/**
 * Web server entry point — runs inside the child process (or foreground).
 * Parses args, runs startup with non-interactive pickers, creates the bridge,
 * starts the HTTP server.
 */

import { randomBytes } from "node:crypto";
import { loadSettings, updateSettings } from "../core/settings.ts";
import type { ParsedArgs } from "../core/startup.ts";
import { runStartup } from "../core/startup.ts";
import type { Pickers, PickOption } from "../pickers/types.ts";
import { createWebBridge } from "./bridge.ts";
import { startWebServer } from "./server.ts";

const VERSION: string = JSON.parse(
	(await import("node:fs")).readFileSync(
		(await import("node:path")).join(
			(await import("node:url")).fileURLToPath(import.meta.url),
			"..",
			"..",
			"..",
			"package.json",
		),
		"utf-8",
	),
).version;

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Parse --port
	let port = parseInt(process.env.CAST_WEB_PORT ?? "3117", 10);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = parseInt(args[i + 1]!, 10);
			i++;
		}
	}

	const settings = loadSettings();
	const cwd = process.env.CAST_CWD
		? (await import("node:path")).resolve(process.env.CAST_CWD)
		: (await import("node:path")).resolve(".");

	// Non-interactive pickers for web mode
	const webPickers: Pickers = {
		pickOption: async <T>(options: PickOption<T>[]): Promise<T | null> => {
			// Auto-select first non-muted option
			const first = options.find((o) => !o.muted);
			return first?.value ?? options[0]?.value ?? null;
		},
		promptText: async (_label: string, defaultValue?: string): Promise<string | null> => defaultValue ?? null,
		pickMulti: async <T>(options: PickOption<T>[]): Promise<T[] | null> => options.map((o) => o.value),
		log: (text: string) => console.log(text),
	};

	// Parse CLI model/persona/reasoning
	let cliModel: string | undefined;
	let cliPersona: string | undefined;
	let cliReasoning: string | undefined;
	let cliBypassPermissions = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i] === "-m") {
			cliModel = args[i + 1];
			i++;
		} else if (args[i] === "--persona" || args[i] === "-p") {
			cliPersona = args[i + 1];
			i++;
		} else if (args[i] === "--reasoning" || args[i] === "-r") {
			cliReasoning = args[i + 1];
			i++;
		} else if (args[i] === "--bypass-permissions") {
			cliBypassPermissions = true;
		}
	}

	const parsedArgs: ParsedArgs = {
		cwd,
		settings,
		cliModel,
		cliReasoning,
		cliPersona,
		initialPrompt: undefined,
		resumeRequested: false,
		resumePicker: false,
		cliBypassPermissions,
		noSkills: false,
		cliSkillPaths: [],
		noMcp: false,
		cliMcpPaths: [],
		version: VERSION,
	};

	// Auth: ensure password exists in settings
	const currentSettings = loadSettings();
	let webPassword = currentSettings.webPassword;
	if (!webPassword) {
		webPassword = randomBytes(18).toString("base64url");
		updateSettings({ webPassword });
		console.log("[cast web] first run — password generated and saved to ~/.cast/settings.json");
	}

	console.log("[cast web] starting up...");
	const result = await runStartup(parsedArgs, webPickers);
	console.log(`[cast web] persona: ${result.persona.label}, model: ${result.session.model}`);
	console.log("[cast web] ────────────────────────────────────");
	console.log(`[cast web]   login:    cast`);
	console.log(`[cast web]   password: ${webPassword}`);
	console.log("[cast web] ────────────────────────────────────");

	const bridge = createWebBridge(result);
	bridge.createSession();

	startWebServer({ port, bridge, webUser: "cast", webPassword });
}

main().catch((err) => {
	console.error("[cast web] fatal:", err);
	process.exit(1);
});
