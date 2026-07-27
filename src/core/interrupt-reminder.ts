/**
 * One-shot interrupt reminder: after a mid-stream user abort that left no
 * tool-result signal, inject a `<system-reminder>` so the next model turn
 * knows the prior turn was cut off.
 */

import type { Message } from "./llm.ts";

/** Body text (wrapped by {@link buildInterruptReminder}). */
export const INTERRUPT_REMINDER_BODY = "[Request interrupted by user]";
/** Body text for a turn cut off by the backend process restarting/shutting
 * down rather than an actual user action — telling the model "by user" here
 * would be false and could make it think it did something wrong. */
export const INTERRUPT_REMINDER_BODY_SHUTDOWN = "[Request interrupted — server restarted]";

const INTERRUPT_REMINDER_PREFIX = "[Request interrupted";

/** Full user-message content ready to append to the transcript. */
export function buildInterruptReminder(reason?: "shutdown"): string {
	const body = reason === "shutdown" ? INTERRUPT_REMINDER_BODY_SHUTDOWN : INTERRUPT_REMINDER_BODY;
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** True when `messages` already ends with our interrupt reminder (idempotent). */
export function messagesEndWithInterruptReminder(messages: Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		const text = typeof m.content === "string" ? m.content : "";
		return text.includes(INTERRUPT_REMINDER_PREFIX) && text.includes("<system-reminder>");
	}
	return false;
}

/**
 * Trailing `role: "tool"` results already told the model the user aborted
 * (bash/ssh `[ABORTED]…`). Skip the reminder — the tool results are enough.
 */
export function trailingToolsSignalUserAbort(messages: Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "tool") break;
		if (typeof m.content === "string" && m.content.includes("[ABORTED]")) return true;
	}
	return false;
}

/**
 * Append the interrupt reminder when needed. Returns true if a message was pushed.
 */
export function appendInterruptReminder(messages: Message[], reason?: "shutdown"): boolean {
	if (messagesEndWithInterruptReminder(messages)) return false;
	if (trailingToolsSignalUserAbort(messages)) return false;
	messages.push({ role: "user", content: buildInterruptReminder(reason) });
	return true;
}
