/**
 * Web slash command registry — single source of truth for which commands the
 * web UI supports and whether each needs the agent idle. `bridge.ts`'s
 * executeCommand gates on `isCommandBlocking`; the client fetches
 * `SLASH_COMMANDS` via GET /api/commands to build its palette, so adding a
 * command here is the one place that needs to change (plus the actual
 * handler in bridge.ts's executeCommand).
 */

/** Commands that work while the agent is running. */
export const NON_BLOCKING_COMMANDS = new Set([
	"/abort",
	"/stop",
	"/current",
	"/help",
	"/usage",
	"/sessions",
	"/queue",
	"/q",
	"/queue-reset",
	"/qr",
	"/steer",
	"/s",
	"/diff",
	"/copy",
	"/theme",
	"/repo",
	"/web",
]);

/** Commands that require the agent to be idle. */
export const BLOCKING_COMMANDS = new Set(["/clear", "/new", "/model", "/persona", "/compact", "/reasoning"]);

export const SLASH_COMMANDS: Array<{
	name: string;
	description: string;
	takesArgs?: boolean;
	blocking: boolean;
}> = [
	{ name: "/abort", description: "Abort the current run", blocking: false },
	{ name: "/clear", description: "Clear context (and save)", blocking: true },
	{ name: "/compact", description: "Compact context now", blocking: true },
	{ name: "/copy", description: "Copy last assistant response", blocking: false },
	{ name: "/current", description: "Show session status", blocking: false },
	{ name: "/diff", description: "Toggle the diff panel", blocking: false },
	{ name: "/help", description: "Show this command list", blocking: false },
	{ name: "/model", description: "Show or change model", takesArgs: true, blocking: true },
	{ name: "/new", description: "Start a new session", blocking: true },
	{ name: "/persona", description: "Show or change persona", takesArgs: true, blocking: true },
	{ name: "/q", description: "Alias for /queue", takesArgs: true, blocking: false },
	{ name: "/queue", description: "Queue a message for after the run", takesArgs: true, blocking: false },
	{ name: "/queue-reset", description: "Clear the message queue", blocking: false },
	{ name: "/qr", description: "Alias for /queue-reset", blocking: false },
	{ name: "/reasoning", description: "Show or change reasoning level", takesArgs: true, blocking: true },
	{ name: "/repo", description: "Show cwd and git branch", blocking: false },
	{ name: "/s", description: "Alias for /steer", takesArgs: true, blocking: false },
	{ name: "/sessions", description: "List sessions", blocking: false },
	{ name: "/steer", description: "Inject a message while running", takesArgs: true, blocking: false },
	{ name: "/theme", description: "Show or change color theme", takesArgs: true, blocking: false },
	{ name: "/usage", description: "Show token and cost usage", blocking: false },
	{ name: "/web", description: "Toggle web tools (web_search, web_fetch)", takesArgs: true, blocking: false },
];

/** Check if a command requires the agent to be idle. */
export function isCommandBlocking(input: string): boolean {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return false;
	const name = trimmed.split(/\s+/)[0]!;
	if (NON_BLOCKING_COMMANDS.has(name)) return false;
	return BLOCKING_COMMANDS.has(name);
}

/** Check if the input is a known slash command. */
export function isSlashCommand(input: string): boolean {
	return input.trim().startsWith("/");
}
