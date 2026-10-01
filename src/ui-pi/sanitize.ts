// What a model reply, a tool's output or a pasted file may carry that a terminal would obey: clear the
// screen, move the cursor, retitle the window, or write the clipboard (OSC 52). Everything that reaches
// the screen as text goes through here first.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_C1 = String.fromCharCode(0x9b);

// OSC (to BEL or ST), DCS/SOS/PM/APC strings, CSI, and any other two-byte escape; the C1 CSI introducer too.
const ESCAPE_SEQUENCES_RE = new RegExp(
	[
		`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
		`${ESC}[PX^_][^${ESC}]*(?:${ESC}\\\\)?`,
		`${ESC}\\[[0-?]*[ -/]*[@-~]`,
		`${CSI_C1}[0-?]*[ -/]*[@-~]`,
		`${ESC}[@-Z\\\\-_]`,
	].join("|"),
	"g",
);
// C0 and C1 controls other than the tab and the line feed, which are handled separately.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the list of what is removed
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const CARRIAGE_RETURN_RE = /\r\n?/g;
const TAB_RE = /\t/g;

/** Spaces for a tab: the layout counts cells itself, and a tab is as wide as the terminal's stops, which it cannot know. */
const TAB_WIDTH = 4;

/** Plain text, safe to lay out and print: no escape sequences, no control characters, tabs as spaces, one kind of line break. */
export function sanitize(text: string): string {
	return text
		.replace(ESCAPE_SEQUENCES_RE, "")
		.replace(CARRIAGE_RETURN_RE, "\n")
		.replace(TAB_RE, " ".repeat(TAB_WIDTH))
		.replace(CONTROL_RE, "");
}
