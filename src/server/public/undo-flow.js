import { api } from "./api.js";

const MAX_NAMES_SHOWN = 6;
const MAX_QUOTE_CHARS = 90;

/**
 * What the confirmation dialog says. Plain text with line breaks: the message
 * the user is about to lose, what happens to the files, and (only when true)
 * what will not come back.
 */
export function describeUndo(preview) {
	const lines = [];
	if (preview.removedMessage) {
		const quote = preview.removedMessage.length > MAX_QUOTE_CHARS ? `${preview.removedMessage.slice(0, MAX_QUOTE_CHARS)}…` : preview.removedMessage;
		lines.push(`Undo the last turn? Your message "${quote}" and everything the agent did after it are removed.`);
	} else {
		lines.push("Undo the last turn?");
	}
	lines.push(
		preview.kind === "files"
			? "Files changed with edit or write are put back."
			: "Every file in the folder goes back to how it was before that turn.",
	);
	if (preview.shellChangesCovered === false) {
		lines.push("This folder is too big to snapshot, so changes made by shell commands are not undone.");
	}
	if (preview.lostTotal > 0) {
		const names = preview.lost.slice(0, MAX_NAMES_SHOWN).join(", ");
		const more = preview.lostTotal > MAX_NAMES_SHOWN ? ` and ${preview.lostTotal - MAX_NAMES_SHOWN} more` : "";
		lines.push(`It also deletes ${preview.lostTotal} file${preview.lostTotal === 1 ? "" : "s"} created since, including anything you added yourself: ${names}${more}.`);
	}
	return lines.join("\n\n");
}

/**
 * Asks the daemon what an undo would do, asks the user, then does it. Returns
 * true when the last turn was undone.
 */
export async function undoLastTurn({ id, confirm, addNotice, showToast, refresh }) {
	let preview;
	try {
		preview = await api("GET", `/api/sessions/${id}/undo`);
	} catch (err) {
		showToast(err.message, "error");
		return false;
	}
	if (!preview?.available) {
		showToast(preview?.reason ?? "Nothing to undo", "error");
		return false;
	}
	if (!(await confirm(describeUndo(preview), { confirmLabel: "Undo" }))) return false;
	try {
		// Forced only when the dialog already named the files it deletes.
		const command = preview.lostTotal > 0 ? "/undo --force" : "/undo";
		const result = await api("POST", `/api/sessions/${id}/command`, { command });
		if (result?.result) addNotice(result.result);
		await refresh();
		return true;
	} catch (err) {
		showToast(err.message, "error");
		return false;
	}
}
