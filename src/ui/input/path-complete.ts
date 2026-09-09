import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Tab-completion for a filesystem path in the composer.
 *
 * Only path-shaped tokens complete — one containing a `/`, or starting with
 * `~`. Tab in the middle of prose would otherwise splice a filename into the
 * sentence: with no completion popup to dismiss, a guess the user did not ask
 * for is worse than doing nothing.
 *
 * Pure except for the directory read, and it returns the edit rather than
 * applying it, so the Composer stays the only place that touches the buffer.
 */
export interface PathCompletion {
	/** Buffer slice the completion replaces. */
	from: number;
	to: number;
	/** Text to put there — the longest unambiguous extension of the token. */
	insert: string;
	/** Every match, for the hint row when the token stays ambiguous. */
	candidates: string[];
}

/** Whitespace ends a token; nothing else does (a path may hold anything else). */
const TOKEN_BREAK = /\s/;

function tokenStart(text: string, cursor: number): number {
	let i = cursor;
	while (i > 0 && !TOKEN_BREAK.test(text[i - 1]!)) i--;
	return i;
}

/** Longest prefix shared by every candidate — how far Tab can commit. */
function commonPrefix(values: string[]): string {
	if (values.length === 0) return "";
	let prefix = values[0]!;
	for (const value of values.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
		prefix = prefix.slice(0, i);
	}
	return prefix;
}

export function completePath(text: string, cursor: number, cwd: string): PathCompletion | null {
	const from = tokenStart(text, cursor);
	const token = text.slice(from, cursor);
	if (!token || (!token.includes("/") && !token.startsWith("~"))) return null;

	const expanded = token.startsWith("~") ? homedir() + token.slice(1) : token;
	const slash = expanded.lastIndexOf("/");
	// `slash === 0` is the root itself, whose directory is "/", not "".
	const dirPart = slash <= 0 ? expanded.slice(0, slash + 1) || "." : expanded.slice(0, slash);
	const base = expanded.slice(slash + 1);
	const dir = isAbsolute(dirPart) ? dirPart : resolve(cwd, dirPart);

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// No such directory, or unreadable — nothing to offer, and a thrown
		// error on Tab would take the whole TUI down with it.
		return null;
	}
	const matches = entries
		// A leading dot has to be asked for, or `ls`-invisible files would
		// dominate every completion in a repo root.
		.filter((entry) => entry.name.startsWith(base) && (base.startsWith(".") || !entry.name.startsWith(".")))
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.sort();
	if (matches.length === 0) return null;

	// A single directory gets its trailing slash, so the next Tab descends into
	// it instead of re-completing the same name.
	const completed = matches.length === 1 ? matches[0]! : commonPrefix(matches);
	if (completed.length < base.length) return null;
	return {
		from: from + (token.length - base.length),
		to: cursor,
		insert: completed,
		candidates: matches,
	};
}
