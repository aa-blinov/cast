/**
 * Web slash command registry — single source of truth for which commands the
 * web UI supports and whether each needs the agent idle. `bridge.ts`'s
 * executeCommand gates on `isCommandBlocking`; the client fetches
 * `SLASH_COMMANDS` via GET /api/commands to build its palette, so adding a
 * command here is the one place that needs to change (plus the actual
 * handler in bridge.ts's executeCommand).
 */

const WHITESPACE_RE = /\s+/;

/** Commands that work while the agent is running. */
export const NON_BLOCKING_COMMANDS = new Set([
	"/abort",
	"/stop",
	"/current",
	"/help",
	"/memory",
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
	"/web-search-provider",
	"/web-fetch-provider",
	"/rules",
	"/rule:",
	"/permissions",
	"/quick-session-persona",
]);

/** Commands that require the agent to be idle. */
export const BLOCKING_COMMANDS = new Set([
	"/clear",
	"/new",
	"/model",
	"/persona",
	"/compact",
	"/dream",
	"/distill",
	"/reasoning",
	"/build",
	"/continue",
	"/fork",
	"/plan",
	"/plan-model",
	"/plugin",
	"/provider",
	"/reload",
	"/subagent-model",
	"/undo",
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
	{ name: "/fork", description: "Fork the current safe context into a new session", blocking: true },
	{ name: "/current", description: "Show session status", blocking: false, hidden: true },
	{ name: "/diff", description: "Toggle the diff panel", blocking: false, hidden: true },
	{ name: "/distill", description: "Package a repeated workflow as a reusable project artifact", blocking: true },
	{ name: "/dream", description: "Consolidate durable project memory", blocking: true },
	{ name: "/evolve", description: "Propose reusable skills for this project from the session", blocking: true },
	{ name: "/help", description: "Show this command list", blocking: false },
	{ name: "/hooks", description: "List/enable/disable hooks", takesArgs: true, blocking: false, hidden: true },
	{ name: "/mcp", description: "Manage MCP servers", takesArgs: true, blocking: false, hidden: true },
	{
		name: "/memory",
		description: "Inspect and control project memory",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
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
	{ name: "/goal", description: "Work toward a goal autonomously until done", takesArgs: true, blocking: true },
	{ name: "/review", description: "Ask the agent to review and verify its own work", blocking: true },
	{ name: "/rule:", description: "Invoke a rule by name", takesArgs: true, blocking: false },
	{ name: "/rules", description: "List loaded rules", blocking: false },
	{ name: "/s", description: "Alias for /steer", takesArgs: true, blocking: false },
	{ name: "/sessions", description: "List sessions", blocking: false, hidden: true },
	{ name: "/skills", description: "Manage skills", takesArgs: true, blocking: false, hidden: true },
	{ name: "/ssh", description: "Manage SSH hosts", takesArgs: true, blocking: false, hidden: true },
	{ name: "/steer", description: "Inject a message while running", takesArgs: true, blocking: false },
	{
		name: "/quick-session-persona",
		description: "Show or change the persona the sidebar's Quick session button uses",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
	{ name: "/stop", description: "Abort the current run (alias)", blocking: false, hidden: true },
	{
		name: "/subagent-model",
		description: "Show or change subagent model",
		takesArgs: true,
		blocking: true,
		hidden: true,
	},
	{ name: "/theme", description: "Show or change color theme", takesArgs: true, blocking: false, hidden: true },
	{
		name: "/turn-cap",
		description: "Show/set the per-turn iteration safety cap (default 500)",
		takesArgs: true,
		blocking: false,
	},
	{ name: "/usage", description: "Show token and cost usage", blocking: false, hidden: true },
	{ name: "/undo", description: "Undo the last turn and restore its files", blocking: true },
	{
		name: "/web",
		description: "Toggle web tools (web_search, web_fetch)",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
	{
		name: "/web-search-provider",
		description: "Switch web_search backend (DuckDuckGo / Tavily / Brave)",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
	{
		name: "/web-fetch-provider",
		description: "Switch web_fetch backend (Jina Reader / local)",
		takesArgs: true,
		blocking: false,
		hidden: true,
	},
];

// The prompt /review submits. Generic enough for any project; the honesty
// clause matters — a review that claims checks it never ran is worse than no
// review. Kept here (the server command registry) so both the bridge handler
// and the TUI's handleInput can share it.
export const REVIEW_PROMPT = `Review the work done in this session as a careful senior engineer.

1. Identify what changed: run git status and git diff if this is a git repo, otherwise list the files touched in this session.
2. Verify it actually holds together: find and run the project's test and lint commands (inspect package.json, pyproject.toml, Cargo.toml, deno.json, go.mod, Makefile, etc.). Fix quick, obvious breakage only if it's safe.
3. Report concisely and honestly: what was implemented, what was verified (name the exact commands you ran and their result), and what remains open, risky, or unverified. Do not claim a check passed unless you actually ran it — if you didn't run something, say so.`;

// The prompt /goal submits — an autonomous "keep going until done" directive,
// MiMo-Code-style: work through iterations without yielding for permission,
// ask at most one clarifying question, verify as you go, and report honestly.
export const GOAL_MAX_OUTER_ITERATIONS = 25;

const GOAL_STEPS_FLAG_RE = /^(?:--steps|-s)\s+(\d+)\s*(.*)$/s;
const GOAL_LEADING_NUMBER_RE = /^(\d+)\s+(.*)$/s;

/** Parse `/goal [--steps N] <description>` — and the ergonomic leading-number
 * form `/goal N <description>` (mirrors `timeout 10 cmd`). A pure integer
 * 1–200 as the first token is the budget; otherwise it's part of the goal
 * text. Returns the goal text and the iteration budget (both the prompt and
 * the loop cap use it). */
export function parseGoalInput(input: string): { goal: string; maxIterations: number } {
	const flagged = input.match(GOAL_STEPS_FLAG_RE);
	if (flagged) {
		return { goal: flagged[2]!.trim(), maxIterations: clampSteps(Number(flagged[1])) };
	}
	const numbered = input.match(GOAL_LEADING_NUMBER_RE);
	if (numbered) {
		const n = Number(numbered[1]);
		if (n >= 1 && n <= 200) return { goal: numbered[2]!.trim(), maxIterations: n };
	}
	return { goal: input.trim(), maxIterations: GOAL_MAX_OUTER_ITERATIONS };
}

function clampSteps(n: number): number {
	return Math.max(1, Math.min(Math.floor(n), 200));
}

export function buildGoalPrompt(goal: string, maxIterations = GOAL_MAX_OUTER_ITERATIONS): string {
	return `You are working toward a goal autonomously. Keep going until it is fully done — do NOT stop after the first attempt, and do NOT yield back to the user for permission mid-task.

Goal: ${goal}

Work as a careful senior engineer:
1. Inspect the repository or context, then implement the smallest steps that move toward the goal.
2. Verify as you go: run the relevant tests/checks for what you changed.
3. Fix issues you find. Iterate until the goal is met or you hit your iteration budget.
4. You have a bounded budget (~${maxIterations} tool iterations). When you believe the goal is met, run a final check and summarize what was done and what was verified.
5. Do not ask "do you want me to also...?" — push forward when the goal is clear. Ask at most ONE question (via the question tool) only if the goal is genuinely ambiguous and the answer would change what you do.
6. Be honest: name exactly which checks you ran and their results. Do not claim a check passed unless you actually ran it.`;
}

/** Check if a command requires the agent to be idle. */
export function isCommandBlocking(input: string): boolean {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return false;
	const [name, ...rest] = trimmed.split(WHITESPACE_RE);
	if (NON_BLOCKING_COMMANDS.has(name!)) return false;
	// "/provider" (bare, or explicit "list") only reads the configured
	// providers — it's just "/provider <name>"/"add"/"delete" that mutate the
	// active endpoint. Reading it is what the web UI's status popover does on
	// every open (including mid-run), so it can't sit behind the same gate as
	// an actual switch.
	if (name === "/provider" && (rest.length === 0 || rest[0] === "list")) return false;
	// Resource-management commands are safe to inspect while a turn runs, but
	// their mutating subcommands can change the tools or environment underneath
	// the active loop. Keep the palette available and gate the actual mutation.
	if (name === "/mcp" || name === "/skills" || name === "/ssh") {
		const readOnly = name === "/ssh" ? [undefined, "list"] : [undefined, "list", "help"];
		return !readOnly.includes(rest[0]);
	}
	// /rule:NAME is one token (no space before the rule id) — the bridge
	// handles it before this gate and checks `running` internally.
	if (BLOCKING_COMMANDS.has(name!)) return true;
	return false;
}

/** Check if the input is a known slash command. */
export function isSlashCommand(input: string): boolean {
	return input.trim().startsWith("/");
}
