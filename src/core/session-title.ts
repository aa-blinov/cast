// renderSkillInvocation's shape: a /skill command reaches the model as the
// whole SKILL.md, with any arguments appended after it.
const SKILL_INVOCATION_RE = /^<skill name="([^"]+)"[^>]*>[\s\S]*<\/skill>(?:\n\nUser: ([\s\S]*))?$/;

/** What a person typed for a /skill command (`/name args`), or undefined when the
 *  text is not a rendered skill invocation. Used so the thread shows the command,
 *  not the skill file the model was handed. */
export function skillInvocationLabel(text: string): string | undefined {
	const skill = SKILL_INVOCATION_RE.exec(text.trim());
	if (!skill) return undefined;
	const args = skill[2]?.trim();
	return `/${skill[1]}${args ? ` ${args}` : ""}`;
}

/** A session title is a compact preview of its first user message. A thread
 *  opened with a /skill command is titled by what was typed, not by the
 *  skill file's opening lines. */
export function deriveSessionTitle(text: string): string {
	const source = skillInvocationLabel(text) ?? text;
	const oneLine = source.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}
