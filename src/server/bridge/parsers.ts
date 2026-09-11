/**
 * Pure parsers for model-emitted JSON that may be wrapped in a markdown code
 * fence or preceded by chain-of-thought. Moved out of server/bridge.ts to
 * keep that file's createServerBridge closure focused on transport and
 * session-state wiring; the parsers themselves have no closure dependencies
 * and were top-level exports, so the move is a straight relocation. bridge.ts
 * re-exports the public names so existing imports (test/web-bridge.test.ts
 * destructures them) keep working.
 */

// Shared markdown code-fence stripping — parseSuggestionJson/parseEvolveJson
// tolerate a model wrapping its JSON in a ```json fence; generateSkillBody
// (still in bridge.ts) tolerates any language tag (or none) around a SKILL.md
// body. All three close on a bare trailing ``` fence.
export const JSON_FENCE_OPEN_RE = /^```(?:json)?\s*/i;
export const CODE_FENCE_OPEN_RE = /^```[^\n]*\n/;
export const CODE_FENCE_CLOSE_RE = /```\s*$/;

/** Parse the skill-suggest eval verdict. Robust to MiniMax inlining its
 * chain-of-thought into `content` before the JSON instead of putting it in a
 * reasoning field — the JSON substring is extracted and parsed. */
export function parseSuggestionJson(content: string): { name: string; description: string } | null {
	const cleaned = content.replace(JSON_FENCE_OPEN_RE, "").replace(CODE_FENCE_CLOSE_RE, "").trim();
	const candidates = [cleaned];
	const firstBrace = cleaned.indexOf("{");
	const lastBrace = cleaned.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as { name?: unknown; description?: unknown };
			if (typeof parsed.name === "string" && parsed.name.trim() && typeof parsed.description === "string") {
				return { name: parsed.name.trim(), description: parsed.description.trim() };
			}
		} catch {
			// Not JSON in this form — try the next candidate.
		}
	}
	return null;
}

/** /evolve suggestion: a reusable skill worth capturing for this project,
 *  scoped to a typical task the session was doing. */
export interface EvolveSkillSuggestion {
	name: string;
	description: string;
}

/** Parse the /evolve verdict. The model returns a JSON array of skill
 *  suggestions (or an empty array); inline chain-of-thought before the JSON
 *  is tolerated, matching parseSuggestionJson's robustness. */
export function parseEvolveJson(content: string): EvolveSkillSuggestion[] {
	const cleaned = content.replace(JSON_FENCE_OPEN_RE, "").replace(CODE_FENCE_CLOSE_RE, "").trim();
	const candidates = [cleaned];
	const firstBrace = cleaned.indexOf("[");
	const lastBrace = cleaned.lastIndexOf("]");
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (Array.isArray(parsed)) {
				return parsed
					.filter(
						(item): item is { name?: unknown; description?: unknown } =>
							typeof item === "object" && item !== null,
					)
					.map((item) => ({
						name: typeof item.name === "string" ? item.name.trim() : "",
						description: typeof item.description === "string" ? item.description.trim() : "",
					}))
					.filter((item) => item.name && item.description);
			}
		} catch {
			// Not JSON in this form — try the next candidate.
		}
	}
	return [];
}
