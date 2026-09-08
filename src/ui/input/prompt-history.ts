/**
 * Prompt history for the composer — ↑/↓ recall previously submitted prompts,
 * the way every other terminal input does.
 *
 * The arrows used to be wired to the text buffer's cursorUp/cursorDown. The
 * composer's buffer is always exactly one line (newline entry was removed and
 * multi-line pastes collapse to a chip — see paste.ts), so ↑ did nothing at
 * all and ↓ jumped the cursor to the end of the line: half a keybinding pair
 * doing nothing and the other half doing something surprising.
 *
 * Pure and React-free so the whole recall dance — enter history, step,
 * come back to the draft you were typing — is unit-testable without a
 * terminal.
 */

/** Prompts kept per session. Recall past a couple of hundred is scrolling, not recall. */
const MAX_ENTRIES = 200;

export class PromptHistory {
	/** Oldest → newest. */
	private entries: string[] = [];
	/** Index into `entries` while browsing; null means "editing the draft". */
	private index: number | null = null;
	/** What was in the composer when browsing started, restored on the way out. */
	private draft = "";

	constructor(seed: readonly string[] = []) {
		for (const entry of seed) this.record(entry);
	}

	get size(): number {
		return this.entries.length;
	}

	/** True while a recalled prompt is being shown rather than the live draft. */
	get browsing(): boolean {
		return this.index !== null;
	}

	/** Add a prompt without touching the browse position (used for seeding). */
	private record(text: string): void {
		const value = text.trim() ? text : "";
		if (!value) return;
		// A prompt repeated back-to-back would otherwise need two presses to
		// step past — the same rule a shell's HISTCONTROL=ignoredups applies.
		if (this.entries[this.entries.length - 1] === value) return;
		this.entries.push(value);
		if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
	}

	/** Record a submitted prompt and leave browsing. */
	push(text: string): void {
		this.record(text);
		this.reset();
	}

	/** Stop browsing; the next ↑ starts from the newest entry again. */
	reset(): void {
		this.index = null;
		this.draft = "";
	}

	/**
	 * One step back in history. `currentDraft` is remembered the first time, so
	 * stepping forward past the newest entry can restore it. Returns null when
	 * there is nothing older to show.
	 */
	older(currentDraft: string): string | null {
		if (this.entries.length === 0) return null;
		if (this.index === null) {
			this.draft = currentDraft;
			this.index = this.entries.length - 1;
			return this.entries[this.index]!;
		}
		if (this.index === 0) return null;
		this.index -= 1;
		return this.entries[this.index]!;
	}

	/**
	 * One step forward. Past the newest entry this returns the draft that was
	 * being typed when browsing started (possibly ""), and leaves browsing.
	 * Returns null when not browsing at all — the caller then does nothing,
	 * rather than clobbering what the user is typing.
	 */
	newer(): string | null {
		if (this.index === null) return null;
		if (this.index >= this.entries.length - 1) {
			const draft = this.draft;
			this.reset();
			return draft;
		}
		this.index += 1;
		return this.entries[this.index]!;
	}
}
