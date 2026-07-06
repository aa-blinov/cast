/**
 * Minimal frontmatter parser shared by skills.ts, personas.ts, and rules.ts —
 * scalars, booleans, and inline YAML arrays. Every field either module reads
 * (name, description, label, globs, ...) is a simple scalar or inline array
 * in practice, so pulling in a YAML dependency isn't worth it.
 */

export type FrontmatterValue = string | boolean | string[];

export interface ParsedFrontmatter {
	frontmatter: Record<string, FrontmatterValue>;
	body: string;
}

/** Parse a YAML inline array like `["a", "b"]` or `[a, b]`. Returns undefined if not an array. */
function parseInlineArray(value: string): string[] | undefined {
	if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
	const inner = value.slice(1, -1).trim();
	if (!inner) return [];
	return inner.split(",").map((s) => {
		let v = s.trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		return v;
	});
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };

	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };

	const yamlBlock = normalized.slice(3, end).trim();
	const body = normalized.slice(end + 4).replace(/^\n/, "");

	const frontmatter: Record<string, FrontmatterValue> = {};
	for (const line of yamlBlock.split("\n")) {
		const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]!;
		let value = match[2]!.trim();
		// Inline YAML array: ["a", "b"] or [a, b]
		const arr = parseInlineArray(value);
		if (arr) {
			frontmatter[key] = arr;
			continue;
		}
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value === "true" ? true : value === "false" ? false : value;
	}

	return { frontmatter, body };
}
