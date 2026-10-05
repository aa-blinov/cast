// What a slash command's answer says in the thread. Most answer in words; some answer with data, and shown as
// JSON that was a wall of braces (`/skills` was five thousand characters of file paths).

const MAX_ITEMS = 40;
const MAX_VALUE = 120;
const NAME_KEYS = ["name", "id", "label", "title"];
const DETAIL_KEYS = ["description", "url", "path", "source", "model"];

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

function scalar(value) {
	if (value === null || value === undefined) return "-";
	if (typeof value === "string") return clip(value.replace(/\s+/g, " "), MAX_VALUE);
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return clip(JSON.stringify(value), MAX_VALUE);
}

function itemLine(item) {
	if (item === null || typeof item !== "object") return scalar(item);
	const nameKey = NAME_KEYS.find((key) => typeof item[key] === "string" && item[key]);
	if (!nameKey) return scalar(item);
	const detail = DETAIL_KEYS.filter((key) => key !== nameKey && typeof item[key] === "string" && item[key])
		.slice(0, 2)
		.map((key) => scalar(item[key]));
	const marks = Object.entries(item)
		.filter(([key, value]) => typeof value === "boolean" && value && !key.startsWith("has"))
		.map(([key]) => key);
	return [item[nameKey], marks.length ? `(${marks.join(", ")})` : "", detail.length ? `- ${detail.join(" - ")}` : ""]
		.filter(Boolean)
		.join(" ");
}

/** The words for an answer that is not already words: its own `text` when it has one, else a short list or `key: value` lines. */
export function commandResultText(result) {
	if (typeof result === "string") return result;
	if (result === null || typeof result !== "object") return String(result);
	if (typeof result.text === "string") return result.text;
	if (Array.isArray(result)) {
		if (result.length === 0) return "None.";
		const lines = result.slice(0, MAX_ITEMS).map((item) => `* ${itemLine(item)}`);
		if (result.length > MAX_ITEMS) lines.push(`… and ${result.length - MAX_ITEMS} more`);
		return lines.join("\n");
	}
	const entries = Object.entries(result);
	if (entries.length === 0) return "Nothing to show.";
	return entries.map(([key, value]) => `${key}: ${Array.isArray(value) ? `${value.length} item${value.length === 1 ? "" : "s"}` : scalar(value)}`).join("\n");
}

/** How long to wait for a command's answer: the ones that put a request to the model take as long as it does. */
const MODEL_COMMAND_RE = /^\/(evolve|compact|btw|distill|dream)(\s|$)/;
export const MODEL_COMMAND_TIMEOUT_MS = 60000;
export function commandTimeoutMs(command) {
	return typeof command === "string" && MODEL_COMMAND_RE.test(command.trim()) ? MODEL_COMMAND_TIMEOUT_MS : undefined;
}
