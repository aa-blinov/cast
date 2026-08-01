/** A session title is a compact preview of its first user message. */
export function deriveSessionTitle(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}
