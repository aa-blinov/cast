import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	Editor,
	type SlashCommand,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { searchProjectFiles } from "../core/file-search.ts";
import { atTokenAt } from "../ui/input/at-mention.ts";
import { theme } from "../ui/themes/index.ts";
import { paint } from "./paint.ts";

const TRAILING_SPACES_RE = / +$/;

/** pi-tui's editor, with the two things the composer had that it lacks: a placeholder, and a history to start over. */
export class CastEditor extends Editor {
	/** What an empty draft says, dimmed after the cursor. */
	placeholder = "";

	render(width: number): string[] {
		const lines = super.render(width);
		// [top border, the draft's first row, ..., bottom border]
		if (!this.placeholder || this.getText() !== "" || lines.length < 3) return lines;
		const content = (lines[1] ?? "").replace(TRAILING_SPACES_RE, "");
		const room = width - visibleWidth(content) - 1;
		if (room < 4) return lines;
		const hint = paint(truncateToWidth(this.placeholder, room, "…"), { color: theme().muted, dim: true });
		lines[1] = `${content} ${hint}`;
		return lines;
	}

	/** A new session (or /new) starts its prompt history from nothing. */
	resetHistory(): void {
		// pi-tui offers no way to empty it; these are its private fields at rest.
		const state = this as unknown as { history: string[]; historyIndex: number; historyDraft: unknown };
		state.history = [];
		state.historyIndex = -1;
		state.historyDraft = null;
	}
}

/**
 * Commands and paths as pi-tui completes them, with `@` files taken from the
 * project's own file listing (git-aware, no `fd` needed) rather than from `fd`.
 */
export class CastAutocompleteProvider implements AutocompleteProvider {
	private readonly inner: CombinedAutocompleteProvider;

	constructor(
		commands: SlashCommand[],
		private readonly cwd: string,
		fdPath: string | null,
	) {
		this.inner = new CombinedAutocompleteProvider(commands, cwd, fdPath);
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const mention = atTokenAt(before, before.length);
		if (!mention) return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		const paths = await searchProjectFiles(this.cwd, mention.query);
		if (options.signal.aborted || paths.length === 0) return null;
		return { items: paths.map((path) => ({ value: `@${path} `, label: path })), prefix: before.slice(mention.from) };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (!prefix.startsWith("@") || !item.value.startsWith("@")) {
			return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}
		const line = lines[cursorLine] ?? "";
		const start = cursorCol - prefix.length;
		const next = [...lines];
		next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
		return { lines: next, cursorLine, cursorCol: start + item.value.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}
}
