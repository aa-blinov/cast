import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CastAutocompleteProvider, CastEditor, midLineSlash } from "../src/ui-pi/editor.ts";

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

describe("a slash word in the middle of a message", () => {
	const skills = [
		{ name: "forge-review", description: "Review a change" },
		{ name: "deep-research", description: "Research a topic" },
	];
	const commands = [{ name: "model", description: "Change model" }, ...skills];
	const signal = new AbortController().signal;
	const provider = () => new CastAutocompleteProvider(commands, "/tmp", null, new Set(), skills);

	it("tells a slash word after other text from the start of the message and from a path", () => {
		expect(midLineSlash(["review with /fo"], 0, 15)).toEqual({ prefix: "/fo", query: "fo" });
		expect(midLineSlash(["/fo"], 0, 3)).toBeUndefined();
		expect(midLineSlash(["  /fo"], 0, 5)).toBeUndefined();
		expect(midLineSlash(["see /etc/ho"], 0, 11)).toBeUndefined();
		expect(midLineSlash(["and/or"], 0, 6)).toBeUndefined();
		expect(midLineSlash(["first", "/fo"], 1, 3)).toEqual({ prefix: "/fo", query: "fo" });
	});

	it("offers skills only, not the commands that work only at the start", async () => {
		const found = await provider().getSuggestions(["use /de"], 0, 7, { signal });
		expect(found?.items.map((i) => i.value)).toEqual(["/deep-research "]);
		expect(found?.prefix).toBe("/de");
		const all = await provider().getSuggestions(["use /"], 0, 5, { signal });
		expect(all?.items.map((i) => i.label).sort()).toEqual(["deep-research", "forge-review"]);
		expect(await provider().getSuggestions(["use /mod"], 0, 8, { signal })).toBeNull();
	});

	it("leaves a path and anything that matches no skill alone", async () => {
		expect((await provider().getSuggestions(["see /etc/ho"], 0, 11, { signal }))?.prefix).toBe("/etc/ho");
		expect(await provider().getSuggestions(["see /tmp"], 0, 8, { signal })).toBeNull();
		expect(await provider().getSuggestions(["либо и/или"], 0, 10, { signal })).toBeNull();
		// Tab still completes a path there.
		const forced = await provider().getSuggestions(["see /tm"], 0, 7, { signal, force: true });
		expect(forced?.items.map((i) => i.value)).toContain("/tmp/");
	});

	it("puts the skill in place of the word and keeps the rest of the line", () => {
		const done = provider().applyCompletion(
			["use /de now"],
			0,
			7,
			{ value: "/deep-research ", label: "deep-research" },
			"/de",
		);
		expect(done.lines[0]).toBe("use /deep-research  now");
		expect(done.cursorCol).toBe("use /deep-research ".length);
	});

	describe("in the editor", () => {
		const type = async (editor: CastEditor, text: string) => {
			for (const char of text) editor.handleInput(char);
			await new Promise((resolve) => setTimeout(resolve, 120));
		};
		const make = () => {
			const editor = new CastEditor(fakeTui, theme);
			editor.setAutocompleteProvider(provider());
			const sent: string[] = [];
			editor.onSubmit = (text) => sent.push(text);
			return { editor, sent };
		};

		it("opens the list while typing, and Tab takes the skill", async () => {
			const { editor, sent } = make();
			await type(editor, "review it with /fo");
			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.handleInput("\t");
			expect(editor.getText()).toBe("review it with /forge-review ");
			expect(sent).toEqual([]);
		});

		it("sends what was typed on Enter, so a word with a slash is not turned into a skill", async () => {
			const { editor, sent } = make();
			await type(editor, "look at /de");
			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.handleInput("\r");
			expect(sent).toEqual(["look at /de"]);
		});

		it("takes the highlighted skill on Enter once the arrows moved to it, without sending", async () => {
			const { editor, sent } = make();
			await type(editor, "use /");
			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			expect(editor.getText()).toMatch(/^use \/(deep-research|forge-review) $/);
			expect(sent).toEqual([]);
		});

		it("does nothing for a plain slash word that matches no skill", async () => {
			const { editor, sent } = make();
			await type(editor, "see /tmp");
			expect(editor.isShowingAutocomplete()).toBe(false);
			editor.handleInput("\r");
			expect(sent).toEqual(["see /tmp"]);
		});
	});
});
