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
	"/rules",
	"/rule:",
	"/permissions",
]);

/** Commands that require the agent to be idle. */
export const BLOCKING_COMMANDS = new Set([
	"/clear",
	"/new",
	"/model",
	"/persona",
	"/compact",
	"/reasoning",
	"/build",
	"/continue",
	"/mcp",
	"/plan",
	"/plan-model",
	"/plugin",
	"/provider",
	"/reload",
	"/skills",
	"/ssh",
	"/subagent-model",
]);

export const SLASH_COMMANDS: Array<{
	name: string;
	description: string;
	takesArgs?: boolean;
	blocking: boolean;
	/** Still a fully working command (bridge.ts's executeCommand handles it,
	 * the Settings modal calls it directly) — just not shown in the composer's
	 * "/" autocomplete, either because it has its own dedicated UI already
	 * (Abort button, sidebar session list) or because it's project/account
	 * administration that doesn't belong mixed into the chat transcript's
	 * flow (see the Settings modal instead). */
	hidden?: boolean;
}> = [
	{ name: "/abort", description: "Abort the current run", blocking: false, hidden: true },
	{ name: "/build", description: "Exit plan mode, restore full toolset", blocking: true },
	{ name: "/clear", description: "Clear context (and save)", blocking: true },
	{ name: "/compact", description: "Compact context now", blocking: true },
	{ name: "/continue", description: "Resume the most recent session", blocking: true, hidden: true },
	{ name: "/copy", description: "Copy last assistant response", blocking: false },
	{ name: "/current", description: "Show session status", blocking: false, hidden: true },
	{ name: "/diff", description: "Toggle the diff panel", blocking: false, hidden: true },
	{ name: "/help", description: "Show this command list", blocking: false },
	{ name: "/mcp", description: "Manage MCP servers", takesArgs: true, blocking: true, hidden: true },
	{ name: "/model", description: "Show or change model", takesArgs: true, blocking: true, hidden: true },
	{ name: "/new", description: "Start a new session", blocking: true },
	{
		name: "/permissions",
		description: "Change bash confirmation mode",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
	{ name: "/persona", description: "Show or change persona", takesArgs: true, blocking: true },
	{ name: "/plan", description: "Enter plan mode (explore + plan only)", blocking: true },
	{
		name: "/plan-model",
		description: "Show or change the plan-mode model",
		takesArgs: true,
		blocking: true,
		hidden: true,
	},
	{ name: "/plugin", description: "Manage installed plugins", takesArgs: true, blocking: true, hidden: true },
	{ name: "/provider", description: "Switch / add / delete providers", takesArgs: true, blocking: true, hidden: true },
	{ name: "/q", description: "Alias for /queue", takesArgs: true, blocking: false },
	{ name: "/qr", description: "Alias for /queue-reset", blocking: false },
	{ name: "/queue", description: "Queue a message for after the run", takesArgs: true, blocking: false },
	{ name: "/queue-reset", description: "Clear the message queue", blocking: false },
	{ name: "/reasoning", description: "Show or change reasoning level", takesArgs: true, blocking: true, hidden: true },
	{ name: "/reload", description: "Reload skills, rules, MCP, and personas", blocking: true, hidden: true },
	{ name: "/repo", description: "Show cwd and git branch", blocking: false, hidden: true },
	{ name: "/rule:", description: "Invoke a rule by name", takesArgs: true, blocking: false },
	{ name: "/rules", description: "List loaded rules", blocking: false },
	{ name: "/s", description: "Alias for /steer", takesArgs: true, blocking: false },
	{ name: "/sessions", description: "List sessions", blocking: false, hidden: true },
	{ name: "/skills", description: "Manage skills", takesArgs: true, blocking: true, hidden: true },
	{ name: "/ssh", description: "Manage SSH hosts", takesArgs: true, blocking: true, hidden: true },
	{ name: "/steer", description: "Inject a message while running", takesArgs: true, blocking: false },
	{ name: "/stop", description: "Abort the current run (alias)", blocking: false, hidden: true },
	{
		name: "/subagent-model",
		description: "Show or change subagent model",
		takesArgs: true,
		blocking: true,
		hidden: true,
	},
	{ name: "/theme", description: "Show or change color theme", takesArgs: true, blocking: false, hidden: true },
	{ name: "/usage", description: "Show token and cost usage", blocking: false, hidden: true },
	{
		name: "/web",
		description: "Toggle web tools (web_search, web_fetch)",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
];

/** Check if a command requires the agent to be idle. */
export function isCommandBlocking(input: string): boolean {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return false;
	const name = trimmed.split(/\s+/)[0]!;
	if (NON_BLOCKING_COMMANDS.has(name)) return false;
	// /rule:NAME is one token (no space before the rule id) — the bridge
	// handles it before this gate and checks `running` internally.
	if (BLOCKING_COMMANDS.has(name)) return true;
	return false;
}

/** Check if the input is a known slash command. */
export function isSlashCommand(input: string): boolean {
	return input.trim().startsWith("/");
}
