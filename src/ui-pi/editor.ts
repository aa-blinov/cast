import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	Editor,
	fuzzyFilter,
	matchesKey,
	type SlashCommand,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { searchProjectFiles } from "../core/file-search.ts";
import { atTokenAt } from "../ui/input/at-mention.ts";
import { theme } from "../ui/themes/index.ts";
import { paint } from "./paint.ts";

const TRAILING_SPACES_RE = / +$/;
/** A slash word at the end of the text before the cursor, after whitespace or at a line start. */
const SLASH_TOKEN_RE = /(?:^|\s)(\/[\w:.-]*)$/;

/**
 * A slash word typed after other text ("review it with /forge"), where only a skill makes sense. The
 * start of the message belongs to the commands, which pi-tui completes by itself; a path (a second
 * slash) is not a skill either.
 */
export function midLineSlash(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): { prefix: string; query: string } | undefined {
	const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
	const token = SLASH_TOKEN_RE.exec(before)?.[1];
	if (!token) return undefined;
	const head = before.slice(0, before.length - token.length);
	if (cursorLine === 0 && head.trim() === "") return undefined;
	return { prefix: token, query: token.slice(1) };
}

/** pi-tui's editor, with the two things the composer had that it lacks: a placeholder, and a history to start over. */
export class CastEditor extends Editor {
	/** What an empty draft says, dimmed after the cursor. */
	placeholder = "";
	/** Whether the arrows moved the highlight in the open list, which makes Enter mean "take that one". */
	private navigated = false;

	private slashInDraft(): boolean {
		const { line, col } = this.getCursor();
		return midLineSlash(this.getLines(), line, col) !== undefined;
	}

	/**
	 * A slash word after other text offers skills as you type, and Tab takes one. Enter sends what was
	 * typed unless the arrows picked something: a path or a word with a slash must not turn into a skill
	 * (or be sent with one) just because the list happened to be open.
	 */
	handleInput(data: string): void {
		const open = this.isShowingAutocomplete();
		if (!open) this.navigated = false;
		const hidden = this as unknown as { cancelAutocomplete(): void; tryTriggerAutocomplete(): void };
		if (open && this.slashInDraft()) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.navigated = true;
			else if (matchesKey(data, "enter")) {
				if (this.navigated) {
					super.handleInput("\t");
					return;
				}
				hidden.cancelAutocomplete();
			}
		}
		super.handleInput(data);
		if (!this.isShowingAutocomplete() && data.length === 1 && data >= " " && this.slashInDraft()) {
			hidden.tryTriggerAutocomplete();
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		// [top border, the draft's first row, ..., bottom border]
		if (!this.placeholder || this.getText() !== "" || lines.length < 3) return lines;
		const content = (lines[1] ?? "").replace(TRAILING_SPACES_RE, "");
		const room = width - visibleWidth(content) - 1;
		if (room < 4) return lines;
		const hint = paint(truncateToWidth(this.placeholder, room, "…"), { color: theme().muted });
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

/** A line that is just a slash and one word: a command typed so far. */
const SLASH_WORD_RE = /^\/(\S+)$/;

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
		/** Commands left out of `commands` on purpose (the settings screen covers them) that still run when typed. */
		private readonly hiddenCommands: ReadonlySet<string> = new Set(),
		/** The skills among `commands`: the only thing offered for a slash word in the middle of a message. */
		private readonly skills: SlashCommand[] = [],
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
		// A hidden command typed in full is not in the list, so the fuzzy matches for it ("/ssh" gives
		// "skills-sh") would be what Enter takes instead of what was typed.
		const typed = SLASH_WORD_RE.exec(before);
		if (cursorLine === 0 && lines.length === 1 && typed?.[1] && this.hiddenCommands.has(typed[1])) return null;
		const mid = midLineSlash(lines, cursorLine, cursorCol);
		if (mid) {
			const found = fuzzyFilter(this.skills, mid.query, (skill) => skill.name);
			if (found.length > 0) {
				return {
					items: found.map((skill) => ({
						value: `/${skill.name} `,
						label: skill.name,
						description: skill.description,
					})),
					prefix: mid.prefix,
				};
			}
			// Paths in the middle of a line are for Tab; the list that opens by itself holds skills only.
			if (!options.force) return null;
		}
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
		const midSkill =
			midLineSlash(lines, cursorLine, cursorCol)?.prefix === prefix &&
			this.skills.some((skill) => `/${skill.name} ` === item.value);
		const replaces = (prefix.startsWith("@") && item.value.startsWith("@")) || midSkill;
		if (!replaces) return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const line = lines[cursorLine] ?? "";
		const start = cursorCol - prefix.length;
		const next = [...lines];
		next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
		return { lines: next, cursorLine, cursorCol: start + item.value.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const mid = midLineSlash(lines, cursorLine, cursorCol);
		if (mid && fuzzyFilter(this.skills, mid.query, (skill) => skill.name).length > 0) return true;
		return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}
}
