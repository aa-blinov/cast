import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { frame, MultiModal, OptionModal, printable, SettingsModal } from "../src/ui-pi/modals.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const options = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta", description: "the second" },
	{ value: "c", label: "Gamma", locked: true },
];

describe("OptionModal", () => {
	it("moves with the arrows, wraps round, and answers with the highlighted value on Enter", () => {
		let answer: string | null | undefined;
		const modal = new OptionModal(options, { title: "Pick" }, (value) => {
			answer = value;
		});
		modal.handleInput("\x1b[B");
		expect(plain(modal.render(60).join("\n"))).toContain("▸ Beta");
		modal.handleInput("\r");
		expect(answer).toBe("b");
	});

	it("answers null on Esc, and will not pick a locked row", () => {
		const answers: Array<string | null> = [];
		const modal = new OptionModal(options, undefined, (value) => answers.push(value));
		modal.handleInput("\x1b[A");
		modal.handleInput("\r");
		expect(answers).toEqual([]);
		modal.handleInput("\x1b");
		expect(answers).toEqual([null]);
	});

	it("filters as you type when the list is searchable, and shows the description of the highlighted row only", () => {
		const modal = new OptionModal(options, { search: { placeholder: "type" } }, () => {});
		modal.handleInput("b");
		modal.handleInput("e");
		const text = plain(modal.render(60).join("\n"));
		expect(text).toContain("Beta");
		expect(text).toContain("the second");
		expect(text).not.toContain("Alpha");
	});
});

describe("OptionModal switch key", () => {
	it("answers with the switch value on ←, → or Tab, and says so in the footer", () => {
		for (const key of ["\x1b[D", "\x1b[C", "\t"]) {
			const answers: Array<string | null> = [];
			const modal = new OptionModal(options, { switchTo: "other view", switchHint: "all sessions" }, (value) =>
				answers.push(value as string | null),
			);
			expect(plain(modal.render(80).join("\n"))).toContain("←/→ all sessions");
			modal.handleInput(key);
			expect(answers).toEqual(["other view"]);
		}
	});

	it("leaves ←, → and Tab alone when there is nothing to switch to", () => {
		const answers: unknown[] = [];
		const modal = new OptionModal(options, undefined, (value) => answers.push(value));
		for (const key of ["\x1b[D", "\x1b[C", "\t"]) modal.handleInput(key);
		expect(answers).toEqual([]);
		expect(plain(modal.render(80).join("\n"))).not.toContain("←/→");
	});
});

describe("OptionModal hints", () => {
	it("sets a row's hint against the right edge, and gives way when the label needs the room", () => {
		const modal = new OptionModal(
			[
				{ value: "m", label: "Model", hint: "mock-model" },
				{ value: "p", label: "A rather long label that leaves no room at all", hint: "value" },
			],
			undefined,
			() => {},
		);
		const rows = modal.render(50).map(plain);
		const model = rows.find((row) => row.includes("Model"))!;
		expect(model).toContain("mock-model");
		expect(model.indexOf("mock-model")).toBeGreaterThan(model.indexOf("Model") + 10);
		expect(rows.find((row) => row.includes("A rather long"))).not.toContain("value");
		for (const row of modal.render(50)) expect(visibleWidth(row)).toBe(50);
	});
});

describe("MultiModal", () => {
	it("toggles with space, skips locked rows, and answers with the chosen indices", () => {
		let answer: number[] | null | undefined;
		const modal = new MultiModal(options, undefined, new Set([0]), (indices) => {
			answer = indices;
		});
		modal.handleInput("\x1b[B");
		modal.handleInput(" ");
		modal.handleInput("\x1b[B");
		modal.handleInput(" ");
		modal.handleInput("\r");
		expect(answer).toEqual([0, 1]);
	});
});

describe("frame and printable", () => {
	it("pads every row to one width, so the box covers what is under it", () => {
		const rows = frame("T", ["short", "a much longer line of text"], "esc", 40);
		for (const row of rows) expect(visibleWidth(row)).toBe(40);
	});

	it("reads typed text and pastes, and ignores control sequences", () => {
		expect(printable("x")).toBe("x");
		expect(printable("hello world")).toBe("hello world");
		expect(printable("\x1b[A")).toBe("");
		expect(printable("\x7f")).toBe("");
	});
});

describe("SettingsModal", () => {
	const build = () => {
		const state = { web: false, theme: "dark" };
		const followUps: Array<(() => Promise<void>) | null> = [];
		const form = {
			title: "Settings",
			rows: () =>
				[
					{ kind: "heading", label: "Session" },
					{ kind: "open", label: "Model", value: "m1", open: async () => {} },
					{ kind: "heading", label: "Behaviour" },
					{
						kind: "toggle",
						label: "Web",
						description: "search the web",
						value: state.web,
						set: (v: boolean) => {
							state.web = v;
							return undefined;
						},
					},
					{
						kind: "choice",
						label: "Theme",
						value: state.theme,
						options: [
							{ value: "dark", label: "dark" },
							{ value: "light", label: "light" },
						],
						set: (v: string) => {
							state.theme = v;
							return undefined;
						},
					},
				] as never,
		};
		const modal = new SettingsModal(
			form,
			(f) => followUps.push(f),
			() => {},
		);
		return { modal, state, followUps };
	};

	it("skips headings, flips a toggle in place, and reads the new value back", () => {
		const { modal, state, followUps } = build();
		modal.handleInput("\x1b[B");
		modal.handleInput(" ");
		expect(state.web).toBe(true);
		expect(followUps).toEqual([]);
		const text = plain(modal.render(60).join("\n"));
		expect(text).toContain("● on");
		expect(text).toContain("search the web");
	});

	it("cycles a choice with the arrows and applies it at once", () => {
		const { modal, state } = build();
		modal.handleInput("\x1b[B");
		modal.handleInput("\x1b[B");
		modal.handleInput("\x1b[C");
		expect(state.theme).toBe("light");
		modal.handleInput("\x1b[D");
		expect(state.theme).toBe("dark");
	});

	it("closes with an open row's follow-up on Enter, and with null on Esc", () => {
		const { modal, followUps } = build();
		modal.handleInput("\r");
		expect(followUps).toHaveLength(1);
		expect(followUps[0]).toBeTypeOf("function");
		modal.handleInput("\x1b");
		expect(followUps[1]).toBeNull();
	});

	it("never draws a line wider than the screen", () => {
		const { modal } = build();
		for (const row of modal.render(40)) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
	});
});
