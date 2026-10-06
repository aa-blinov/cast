import { loadSettings } from "../../core/settings.ts";
import { type KeyId, matchesKey } from "./keys.ts";

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}

export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"editor.cursorUp": { defaultKeys: "up" },
	"editor.cursorDown": { defaultKeys: "down" },
	"editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"] },
	"editor.cursorRight": { defaultKeys: ["right", "ctrl+f"] },
	"editor.cursorWordLeft": { defaultKeys: ["alt+left", "ctrl+left", "alt+b"] },
	"editor.cursorWordRight": { defaultKeys: ["alt+right", "ctrl+right", "alt+f"] },
	"editor.cursorLineStart": { defaultKeys: ["home", "ctrl+a"] },
	"editor.cursorLineEnd": { defaultKeys: ["end", "ctrl+e"] },
	"editor.deleteCharBackward": { defaultKeys: "backspace" },
	"editor.deleteCharForward": { defaultKeys: ["delete", "ctrl+d"] },
	"editor.deleteWordBackward": { defaultKeys: ["ctrl+w", "alt+backspace"] },
	"editor.deleteWordForward": { defaultKeys: ["alt+d", "alt+delete"] },
	"editor.deleteToLineStart": { defaultKeys: "ctrl+u" },
	"editor.deleteToLineEnd": { defaultKeys: "ctrl+k" },
	"editor.clearBuffer": { defaultKeys: "ctrl+l", description: "Clear the composer in any state" },
	"input.submit": { defaultKeys: "enter" },
	// Terminals that speak the Kitty protocol or modifyOtherKeys report these;
	// a plain one sends the same bytes for Enter and Shift+Enter, so the
	// composer also accepts a trailing backslash before Enter (see doSubmit).
	"editor.insertNewline": {
		defaultKeys: ["shift+enter", "alt+enter"],
		description: "Insert a line break (or end the line with \\ and press Enter)",
	},
	"input.otherMode": {
		defaultKeys: "alt+enter",
		description:
			"While a turn runs: send the message the other way (queue it after the turn, or steer it into the turn)",
	},
	"input.abort": { defaultKeys: "ctrl+c" },
	"input.quit": { defaultKeys: "ctrl+q", description: "Quit at once, with no second press" },
	"input.escape": { defaultKeys: "escape" },
	"input.attachImage": { defaultKeys: "ctrl+g" },
	"input.externalEditor": { defaultKeys: "ctrl+x", description: "Edit the prompt in $VISUAL / $EDITOR" },
	"input.tab": { defaultKeys: "tab" },
	"history.older": { defaultKeys: "pageUp", description: "Load older session history" },
} as const satisfies KeybindingDefinitions;

export type Keybinding = keyof typeof TUI_KEYBINDINGS;

export class KeybindingsManager {
	private keysById = new Map<Keybinding, KeyId[]>();

	constructor(userBindings: KeybindingsConfig = {}) {
		for (const [id, definition] of Object.entries(TUI_KEYBINDINGS)) {
			const userKeys = userBindings[id];
			const keys =
				userKeys === undefined
					? Array.isArray(definition.defaultKeys)
						? definition.defaultKeys
						: [definition.defaultKeys]
					: Array.isArray(userKeys)
						? userKeys
						: [userKeys];
			this.keysById.set(id as Keybinding, keys);
		}
	}

	keysFor(keybinding: Keybinding): KeyId[] {
		return this.keysById.get(keybinding) ?? [];
	}

	matches(data: string, keybinding: Keybinding): boolean {
		const keys = this.keysById.get(keybinding) ?? [];
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}
}

let globalKeybindings: KeybindingsManager | null = null;

/** Only string or string-array values: anything else in settings.json is ignored, not fatal. */
export function sanitizeKeybindings(raw: unknown): KeybindingsConfig {
	if (!raw || typeof raw !== "object") return {};
	const out: KeybindingsConfig = {};
	for (const [id, keys] of Object.entries(raw)) {
		if (!(id in TUI_KEYBINDINGS)) continue;
		if (typeof keys === "string") out[id] = keys as KeyId;
		else if (Array.isArray(keys) && keys.every((k) => typeof k === "string")) out[id] = keys as KeyId[];
	}
	return out;
}

export function getKeybindings(): KeybindingsManager {
	if (!globalKeybindings) globalKeybindings = new KeybindingsManager(sanitizeKeybindings(loadSettings().keybindings));
	return globalKeybindings;
}

/** A key as the screen writes it: `ctrl+q` is "Ctrl+Q", `alt+left` is "Alt+left". */
export function keyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("+");
}
