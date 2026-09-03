/**
 * `<system-reminder>` blocks — cast's internal protocol messages.
 *
 * They are injected as `role: "user"` because the OpenAI-compatible wire
 * format has no dedicated role for "the harness is telling the model
 * something": interrupt notices, the post-compaction state block, the
 * date-rollover notice, background-task completions, attached-file lists.
 * They are meant for the model, never for the person reading the transcript,
 * so every surface has to strip them out and present them (if at all) as its
 * own kind of notice.
 *
 * That stripping used to be re-implemented per surface — the web bridge, the
 * TUI and the web client each had their own copy of the same regex, and the
 * ACP adapter had none at all, so an editor replaying a loaded session showed
 * the raw `<system-reminder>` XML as if the user had typed it.
 */

const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

export interface ExtractedReminders {
	/** The message text with every reminder block removed, trimmed. */
	cleaned: string;
	/** Each reminder's body, in order, trimmed. */
	reminders: string[];
}

/** Split a message's text into its real content and the reminders it carries. */
export function extractSystemReminders(text: string): ExtractedReminders {
	const reminders: string[] = [];
	const cleaned = text
		.replace(SYSTEM_REMINDER_RE, (_, body: string) => {
			reminders.push(body.trim());
			return "";
		})
		.trim();
	return { cleaned, reminders };
}

/** True when the text is nothing but reminder blocks — a message that exists
 * only to talk to the model and has nothing to show a reader. */
export function isReminderOnly(text: string): boolean {
	const { cleaned, reminders } = extractSystemReminders(text);
	return cleaned === "" && reminders.length > 0;
}
