const SPACE_RE = /\s/;

/** The `@query` token the cursor is in, if any: `@` must start a word, so an e-mail address doesn't open the picker. */
export function atTokenAt(value: string, cursor: number): { from: number; query: string } | undefined {
	let from = cursor;
	while (from > 0 && !SPACE_RE.test(value[from - 1] as string)) from--;
	if (value[from] !== "@") return undefined;
	return { from, query: value.slice(from + 1, cursor) };
}
