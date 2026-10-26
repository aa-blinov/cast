import type { ToolResult } from "./tools.ts";

export interface ToolCallResult {
	id: string;
	name: string;
	result: ToolResult;
}

/** Polling a running background task can legitimately return the same output. */
export const DOOM_LOOP_EXEMPT = new Set<string>(["bash_output"]);

/** How many times a tool may return the same output before the model is told
 *  that repeating it won't change anything. */
const REPEATED_OUTPUT_THRESHOLD = 4;
/** Stop a turn after a runaway keeps returning the same output. */
export const REPEATED_OUTPUT_STOP = 25;
const DIGITS_RE = /\d+/g;

/**
 * The doom-loop guard only sees identical calls. This counts identical results
 * with numbers masked, so timings and PIDs do not hide repeated failures.
 */
export function noteRepeatedOutputs(batch: ToolCallResult[], seen: Map<string, number>): boolean {
	let runaway = false;
	for (const call of batch) {
		const content = call.result.content;
		if (typeof content !== "string" || !content.trim()) continue;
		const key = `${call.name}\0${content.slice(0, 4000).replace(DIGITS_RE, "#")}`;
		const count = (seen.get(key) ?? 0) + 1;
		seen.set(key, count);
		if (count >= REPEATED_OUTPUT_STOP && !DOOM_LOOP_EXEMPT.has(call.name)) runaway = true;
		if (count % REPEATED_OUTPUT_THRESHOLD !== 0) continue;
		call.result = {
			...call.result,
			content: `${content}\n\n<system-reminder>This is the ${count}th time ${call.name} has returned this same output. Repeating the check won't change it. Either do something materially different, or stop and tell the user what is blocking you and what you already tried.</system-reminder>`,
		};
	}
	return runaway;
}

/** How many failures of the same tool in a row earn the model a reminder. */
const REPEATED_FAILURE_NUDGE = 3;
/** The doom-loop block already tells the model to stop. */
export const DOOM_LOOP_MESSAGE = "Doom loop detected:";

export function noteRepeatedFailures(batch: ToolCallResult[], seen: Map<string, number>): void {
	for (const call of batch) {
		if (!call.result.isError) {
			seen.delete(call.name);
			continue;
		}
		if (call.result.content.startsWith(DOOM_LOOP_MESSAGE)) continue;
		const count = (seen.get(call.name) ?? 0) + 1;
		seen.set(call.name, count);
		if (count % REPEATED_FAILURE_NUDGE !== 0) continue;
		call.result = {
			...call.result,
			content: `${call.result.content}\n\n<system-reminder>This is the ${count}${ordinalSuffix(count)} time ${call.name} has failed in a row. Another attempt with a slightly different argument will not change the answer: either try a materially different approach, or stop and tell the user what is blocking you and what you have already tried.</system-reminder>`,
		};
	}
}

/** The check a command is: its first command, without a leading directory change or redirection. */
const DIR_CHANGE_PREFIX_RE = /^\s*(?:cd|pushd)\s+[^&|;]+(&&|;)\s*/i;
const CHECK_SPLIT_RE = /\||;/;
const REDIRECTION_RE = /\d?>\s*&?\d?\s*[a-z_./-]*/gi;
const WHITESPACE_RE = /\s+/g;

export function checkKeyFor(command: string): string {
	const withoutDirChange = command.replace(DIR_CHANGE_PREFIX_RE, "");
	const head = withoutDirChange.split(CHECK_SPLIT_RE)[0] ?? withoutDirChange;
	return head.replace(REDIRECTION_RE, " ").replace(WHITESPACE_RE, " ").trim().toLowerCase();
}

export interface CheckMemory {
	turn: number;
	shown?: boolean;
}

export function noteEarlierCheck(
	batch: ToolCallResult[],
	memory: Map<string, CheckMemory>,
	turn: number,
	commands: Map<string, string>,
	lastMutationTurn: number,
): void {
	for (const call of batch) {
		if (call.name !== "bash" || call.result.isError !== true) continue;
		const command = commands.get(call.id);
		if (!command) continue;
		const key = checkKeyFor(command);
		if (!key) continue;
		const earlier = memory.get(key);
		if (!earlier) {
			memory.set(key, { turn });
			continue;
		}
		if (earlier.shown) continue;
		earlier.shown = true;
		const unchanged = lastMutationTurn <= earlier.turn;
		call.result = {
			...call.result,
			content: `${call.result.content}\n\n<system-reminder>This check failed earlier too (turn ${earlier.turn})${unchanged ? "; no edit or write since" : ""}. Its earlier output is in that turn.</system-reminder>`,
		};
	}
}

function ordinalSuffix(count: number): string {
	const lastTwo = count % 100;
	if (lastTwo >= 11 && lastTwo <= 13) return "th";
	switch (count % 10) {
		case 1:
			return "st";
		case 2:
			return "nd";
		case 3:
			return "rd";
		default:
			return "th";
	}
}
