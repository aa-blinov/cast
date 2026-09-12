/**
 * Command registry — a dispatch table for `bridge.executeCommand(name, args)`.
 *
 * Moved out of server/bridge.ts as the first slice of the executeCommand
 * refactor (per TDD discipline: small vertical slices, characterization tests
 * at the public seam before each move). Only the read-only "session info"
 * commands are registered here so far — `/help` and `/usage`. Future slices
 * will register `/current`, `/repo`, and the rest, with the context
 * interface growing to carry whatever deps those handlers need (cwd
 * fallback, config, loadSettings, etc).
 *
 * The dispatcher is intentionally tiny: `bridge.executeCommand` looks up the
 * name in the registry, hands the context to the handler, returns its
 * result. If no handler is registered, the dispatcher returns `undefined`
 * and `bridge.executeCommand` falls through to the existing inline logic —
 * so this file can land without breaking the 50+ commands still inside
 * bridge.ts.
 *
 * The seam under test (web-bridge.test.ts) is `bridge.executeCommand(name)`;
 * these handlers are tested through it, not directly.
 */

import type { WebAgentSession } from "../bridge.ts";
import { SLASH_COMMANDS } from "../commands.ts";

/**
 * Public result shape of `bridge.executeCommand`. Defined here (not imported
 * from bridge.ts) so command-registry.ts has zero runtime coupling to the
 * closure module — bridge.ts re-exports the same shape so external callers
 * see one type.
 */
export interface CommandResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/**
 * The minimal context slice 1 commands need: the session the command targets
 * and the argument string after the slash. Wider context (cwd fallback,
 * config, loadSettings, etc) will be added as later slices register
 * commands that need them.
 */
export interface CommandContext {
	ws: WebAgentSession;
	arg: string;
}

/** Synchronous handlers — async work happens before this entry point. */
export type CommandHandler = (ctx: CommandContext) => CommandResult;

/**
 * Renders the visible-command list as a markdown block — same output the
 * inline `getHelpText` closure used to produce. Hidden commands
 * (MCP/skills/provider/SSH/theme/...) live in the Settings modal now, so
 * they're filtered out here. The exact set of visible commands drives
 * the "Blocking" footer too, so the help text stays self-consistent
 * with `isCommandBlocking` even as commands are added or hidden.
 */
function getHelpText(): string {
	const visible = SLASH_COMMANDS.filter((c) => !c.hidden);
	const lines = visible.map((c) => `- \`${c.name}\` — ${c.description}`);
	const blocking = visible.filter((c) => c.blocking).map((c) => c.name);
	return [
		"**Available commands:**",
		"",
		...lines,
		"",
		`*Blocking (require idle): ${blocking.join(", ")}. Everything else works while the agent runs.*`,
		"",
		"*MCP, skills, provider, SSH, theme, model/reasoning details, and usage live in Settings (gear icon).*",
	].join("\n");
}

export const commandRegistry: Record<string, CommandHandler> = {
	"/help": () => ({ ok: true, result: getHelpText() }),
	"/usage": ({ ws }) => ({ ok: true, result: ws.session.usage }),
};

/**
 * Dispatch a command by name through the registry. Returns the handler's
 * result, or `undefined` if no handler is registered for this name —
 * `bridge.executeCommand` falls through to its inline logic in that case.
 */
export function dispatchRegisteredCommand(name: string, ctx: CommandContext): CommandResult | undefined {
	const handler = commandRegistry[name];
	if (!handler) return undefined;
	return handler(ctx);
}
