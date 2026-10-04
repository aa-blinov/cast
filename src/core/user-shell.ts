import type { AppConfig } from "./config.ts";
import { checkReadOnlyCommand } from "./plan.ts";
import { execBash } from "./tools/bash.ts";
import type { ConfirmBash } from "./tools/shared.ts";

/**
 * `!command` in the prompt: a command the person runs themselves, with no model turn. Its output is shown and put in
 * the conversation, so the next message can refer to it ("fix what that printed"), the way it would if the model had
 * run it, except that the model knows it did not.
 */

export type UserShellInput =
	| { kind: "run"; command: string }
	/** `!` alone: nothing to run. */
	| { kind: "empty" }
	/** `!!text` is a message that starts with a `!`, for the model: the text, without the escaping one. */
	| { kind: "text"; text: string };

/** What a line of input means for `!`, or undefined when it is not about `!` at all. */
export function parseUserShellInput(input: string): UserShellInput | undefined {
	if (!input.startsWith("!")) return undefined;
	if (input.startsWith("!!")) return { kind: "text", text: input.slice(1) };
	const command = input.slice(1).trim();
	return command ? { kind: "run", command } : { kind: "empty" };
}

const CONTEXT_PREFIX = "The user ran a shell command themselves (you did not run it):\n";
const OPEN_TAG_RE = /^<user-shell command="([^"]*)">\n/;
const CLOSE_TAG = "\n</user-shell>";
const ESCAPED_CLOSE_TAG_RE = /<\\\/user-shell>/g;
const CLOSE_TAG_RE = /<\/user-shell>/g;

const escapeAttribute = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unescapeAttribute = (s: string) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");

/** The message that puts a run of the person's command in the conversation. */
export function userShellMessage(command: string, output: string): string {
	// An output that contains the closing tag must not end the block early.
	const body = output.replace(CLOSE_TAG_RE, "<\\/user-shell>");
	return `${CONTEXT_PREFIX}<user-shell command="${escapeAttribute(command)}">\n${body}${CLOSE_TAG}`;
}

/** The command and its output out of such a message, for showing it as what it is; undefined for any other text. */
export function parseUserShellMessage(text: string): { command: string; output: string } | undefined {
	if (!text.startsWith(CONTEXT_PREFIX)) return undefined;
	const rest = text.slice(CONTEXT_PREFIX.length);
	const open = OPEN_TAG_RE.exec(rest);
	if (!open || !rest.endsWith(CLOSE_TAG)) return undefined;
	return {
		command: unescapeAttribute(open[1]!),
		output: rest.slice(open[0].length, rest.length - CLOSE_TAG.length).replace(ESCAPED_CLOSE_TAG_RE, "</user-shell>"),
	};
}

export interface UserShellDeps {
	cwd: string;
	config: AppConfig;
	/** Plan mode (or a read-only run): only inspection commands. */
	readOnly: boolean;
	/** The same confirmation the bash tool asks for a dangerous command; absent means nobody can be asked. */
	confirm?: ConfirmBash;
	signal?: AbortSignal;
}

export type UserShellResult =
	| { ran: true; output: string; failed: boolean; message: string }
	/** Not run: the reason, to be said to the person; nothing is added to the conversation. */
	| { ran: false; reason: string };

/** Runs the command the way the bash tool would, through the same gates. */
export async function runUserShell(command: string, deps: UserShellDeps): Promise<UserShellResult> {
	if (deps.readOnly) {
		const verdict = await checkReadOnlyCommand(command);
		if (!verdict.ok)
			return { ran: false, reason: `Not run: plan mode allows read-only commands only (${verdict.reason}).` };
	}
	const result = await execBash({ command }, deps.cwd, deps.config, deps.confirm, deps.signal);
	if (result.isError && result.content.startsWith("Blocked:")) return { ran: false, reason: result.content };
	return {
		ran: true,
		output: result.content,
		failed: result.isError === true,
		message: userShellMessage(command, result.content),
	};
}
