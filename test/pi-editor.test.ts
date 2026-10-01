import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CastAutocompleteProvider, CastEditor } from "../src/ui-pi/editor.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const fakeTui = { terminal: { rows: 30, columns: 80 }, requestRender() {} } as unknown as TUI;
const identity = (text: string) => text;
const theme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

describe("CastEditor", () => {
	it("says what an empty draft is for, and stops once there is text", () => {
		const editor = new CastEditor(fakeTui, theme, { paddingX: 1 });
		editor.placeholder = "ask cast to do anything";
		expect(plain(editor.render(60)[1]!)).toContain("ask cast to do anything");
		editor.setText("hello");
		const rows = editor.render(60).map(plain);
		expect(rows.join("\n")).not.toContain("ask cast");
		expect(rows.join("\n")).toContain("hello");
	});

	it("never lets the placeholder outrun a narrow width", () => {
		const editor = new CastEditor(fakeTui, theme, { paddingX: 1 });
		editor.placeholder = "type to steer the running turn – esc esc to stop";
		for (const row of editor.render(30)) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
	});

	it("forgets its prompt history for a new session", () => {
		const editor = new CastEditor(fakeTui, theme);
		editor.addToHistory("old prompt");
		editor.resetHistory();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("");
	});
});

describe("CastAutocompleteProvider", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-pi-editor-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "parser.ts"), "");
		writeFileSync(join(dir, "notes.txt"), "");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("suggests project files for an @ mention, and completes it in place with a trailing space", async () => {
		const provider = new CastAutocompleteProvider([], dir, null);
		const got = await provider.getSuggestions(["see @pars"], 0, 9, { signal: new AbortController().signal });
		expect(got?.prefix).toBe("@pars");
		expect(got?.items.map((i) => i.value)).toContain("@src/parser.ts ");
		const item = got!.items.find((i) => i.value === "@src/parser.ts ")!;
		const applied = provider.applyCompletion(["see @pars later"], 0, 9, item, got!.prefix);
		expect(applied.lines[0]).toBe("see @src/parser.ts  later");
		expect(applied.cursorCol).toBe("see @src/parser.ts ".length);
	});

	it("leaves an e-mail address and slash commands to pi-tui", async () => {
		const provider = new CastAutocompleteProvider([{ name: "help", description: "Show help" }], dir, null);
		expect(await provider.getSuggestions(["me@host"], 0, 7, { signal: new AbortController().signal })).toBeNull();
		const commands = await provider.getSuggestions(["/he"], 0, 3, { signal: new AbortController().signal });
		expect(commands?.items.map((i) => i.value)).toContain("help");
	});

	it("offers nothing for a hidden command typed in full, so Enter runs it and not a fuzzy neighbour", async () => {
		const commands = [
			{ name: "skills-sh", description: "skills.sh" },
			{ name: "sessions", description: "Sessions" },
		];
		const signal = new AbortController().signal;
		const plainProvider = new CastAutocompleteProvider(commands, dir, null);
		// Without the hidden set "/ssh" fuzzy-matches "skills-sh", which Enter would then take.
		expect((await plainProvider.getSuggestions(["/ssh"], 0, 4, { signal }))?.items.map((i) => i.value)).toEqual([
			"skills-sh",
		]);
		const provider = new CastAutocompleteProvider(commands, dir, null, new Set(["ssh"]));
		expect(await provider.getSuggestions(["/ssh"], 0, 4, { signal })).toBeNull();
		// Still completes what is not a hidden command, and a longer word keeps its suggestions.
		expect((await provider.getSuggestions(["/sess"], 0, 5, { signal }))?.items.map((i) => i.value)).toEqual([
			"sessions",
		]);
	});
});
