import { api } from "./api.js";

const MAX_NAMES_SHOWN = 6;
const MAX_QUOTE_CHARS = 90;

/**
 * The question asked before a rewind: what each button does, and only what is
 * true about this folder (shell changes that stay, files it would delete).
 */
export function describeRewind(preview) {
	const quote = preview.message
		? preview.message.length > MAX_QUOTE_CHARS
			? `${preview.message.slice(0, MAX_QUOTE_CHARS)}…`
			: preview.message
		: null;
	const turns = preview.turns ?? 1;
	const lines = [quote ? `Rewind to before your message "${quote}"?` : "Rewind to before that message?"];
	if (preview.conversationAvailable === false) {
		lines.push("That message is no longer in the conversation the model sees, so only the files can go back.");
		lines.push("Files only: put the files back as they were then; the conversation stays as it is.");
	} else {
		const removed = `this message and everything after it (${turns} turn${turns === 1 ? "" : "s"})`;
		lines.push(`Files and conversation: the files go back as they were then, and ${removed} is removed.`);
		lines.push("Files only: the files go back; the conversation stays as it is.");
		lines.push(`Conversation only: ${removed} is removed; the files stay as they are.`);
	}
	if (preview.shellChangesCovered === false) {
		lines.push("This folder is too big to snapshot, so changes made by shell commands are not undone.");
	}
	if (preview.lostTotal > 0) {
		const names = preview.lost.slice(0, MAX_NAMES_SHOWN).join(", ");
		const more = preview.lostTotal > MAX_NAMES_SHOWN ? ` and ${preview.lostTotal - MAX_NAMES_SHOWN} more` : "";
		lines.push(
			`Putting the files back also deletes ${preview.lostTotal} file${preview.lostTotal === 1 ? "" : "s"} created since, including anything you added yourself: ${names}${more}.`,
		);
	}
	return lines.join("\n\n");
}

/** The buttons for a preview, in the order they are shown after Cancel. */
export function rewindChoices(preview) {
	if (preview.conversationAvailable === false) return [{ label: "Files only", value: "code", primary: true }];
	return [
		{ label: "Conversation only", value: "conversation" },
		{ label: "Files only", value: "code" },
		{ label: "Files and conversation", value: "both", primary: true },
	];
}

/**
 * Asks the daemon what rewinding to before the message would do, asks the user
 * what should go back, then does it. Returns true when something was rewound.
 */
export async function rewindTo({ id, userSeq, confirm, addNotice, showToast, refresh }) {
	let preview;
	try {
		preview = await api("GET", `/api/sessions/${id}/rewind?userSeq=${userSeq}`);
	} catch (err) {
		showToast(err.message, "error");
		return false;
	}
	if (!preview?.available) {
		showToast(preview?.reason ?? "Nothing to rewind to", "error");
		return false;
	}
	const mode = await confirm(describeRewind(preview), { choices: rewindChoices(preview) });
	if (!mode) return false;
	try {
		// Forced only when the dialog already named the files it deletes.
		const force = preview.lostTotal > 0 && mode !== "conversation";
		const result = await api("POST", `/api/sessions/${id}/rewind`, { userSeq, mode, force });
		if (result?.result) addNotice(result.result);
		await refresh();
		return true;
	} catch (err) {
		showToast(err.message, "error");
		return false;
	}
}
