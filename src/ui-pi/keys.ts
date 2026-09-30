import { type KeybindingsConfig, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { loadSettings } from "../core/settings.ts";
import { sanitizeKeybindings } from "../ui/input/keybindings.ts";

// settings.json names a binding `input.submit`; pi-tui's editor knows it as
// `tui.input.submit`. The editing ones carry over, the rest (abort, image,
// external editor) are read through cast's own manager by the app.
const PI_BINDING_FOR: Record<string, string> = {
	"editor.cursorUp": "tui.editor.cursorUp",
	"editor.cursorDown": "tui.editor.cursorDown",
	"editor.cursorLeft": "tui.editor.cursorLeft",
	"editor.cursorRight": "tui.editor.cursorRight",
	"editor.cursorWordLeft": "tui.editor.cursorWordLeft",
	"editor.cursorWordRight": "tui.editor.cursorWordRight",
	"editor.cursorLineStart": "tui.editor.cursorLineStart",
	"editor.cursorLineEnd": "tui.editor.cursorLineEnd",
	"editor.deleteCharBackward": "tui.editor.deleteCharBackward",
	"editor.deleteCharForward": "tui.editor.deleteCharForward",
	"editor.deleteWordBackward": "tui.editor.deleteWordBackward",
	"editor.deleteWordForward": "tui.editor.deleteWordForward",
	"editor.deleteToLineStart": "tui.editor.deleteToLineStart",
	"editor.deleteToLineEnd": "tui.editor.deleteToLineEnd",
	"editor.insertNewline": "tui.input.newLine",
	"input.submit": "tui.input.submit",
	"input.tab": "tui.input.tab",
};

/** The user's `keybindings` from settings.json, applied to pi-tui's editor. */
export function applyUserKeybindings(): void {
	const mine = sanitizeKeybindings(loadSettings().keybindings);
	const theirs: Record<string, unknown> = {};
	for (const [id, keys] of Object.entries(mine)) {
		const piId = PI_BINDING_FOR[id];
		if (piId && keys !== undefined) theirs[piId] = keys;
	}
	if (Object.keys(theirs).length === 0) return;
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, theirs as KeybindingsConfig));
}
