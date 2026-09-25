// renderSkillInvocation's shape: a /skill command reaches the model as the
// whole SKILL.md, with any arguments appended after it.
const SKILL_INVOCATION_RE = /^<skill name="([^"]+)"[^>]*>[\s\S]*<\/skill>(?:\n\nUser: ([\s\S]*))?$/;

/** A session title is a compact preview of its first user message. A thread
 *  opened with a /skill command is titled by what was typed, not by the
 *  skill file's opening lines. */
export function deriveSessionTitle(text: string): string {
	const skill = SKILL_INVOCATION_RE.exec(text.trim());
	const source = skill ? `/${skill[1]}${skill[2]?.trim() ? ` ${skill[2].trim()}` : ""}` : text;
	const oneLine = source.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}
