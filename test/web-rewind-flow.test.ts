import { describe, expect, it, vi } from "vitest";

vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }), { virtual: true });

const { describeRewind, rewindChoices, rewindTo } = await import("../src/server/public/rewind-flow.js");
const { api } = await import("../src/server/public/api.js");

const base = {
	available: true,
	kind: "git",
	shellChangesCovered: true,
	message: "fix the bug",
	turns: 2,
	conversationAvailable: true,
	lostTotal: 0,
	lost: [],
};

describe("describeRewind", () => {
	it("says what each button does, with the turns that go", () => {
		const text = describeRewind(base);
		expect(text).toContain('Rewind to before your message "fix the bug"?');
		expect(text).toContain(
			"Files and conversation: the files go back as they were then, and this message and everything after it (2 turns) is removed.",
		);
		expect(text).toContain("Files only: the files go back; the conversation stays as it is.");
		expect(text).toContain(
			"Conversation only: this message and everything after it (2 turns) is removed; the files stay as they are.",
		);
		expect(text).not.toContain("shell commands");
		expect(text).not.toContain("deletes");
	});

	it("says turn for one", () => {
		expect(describeRewind({ ...base, turns: 1 })).toContain("(1 turn)");
	});

	it("offers only the files when the message left the model's conversation", () => {
		const text = describeRewind({ ...base, conversationAvailable: false });
		expect(text).toContain("only the files can go back");
		expect(text).not.toContain("Conversation only");
		expect(rewindChoices({ ...base, conversationAvailable: false })).toEqual([
			{ label: "Files only", value: "code", primary: true },
		]);
	});

	it("warns about shell changes and names the files it deletes", () => {
		const text = describeRewind({
			...base,
			shellChangesCovered: false,
			lostTotal: 8,
			lost: ["a", "b", "c", "d", "e", "f", "g", "h"],
		});
		expect(text).toContain("changes made by shell commands are not undone");
		expect(text).toContain(
			"also deletes 8 files created since, including anything you added yourself: a, b, c, d, e, f and 2 more.",
		);
		expect(describeRewind({ ...base, lostTotal: 1, lost: ["x"] })).toContain("deletes 1 file created since");
	});

	it("copes with a message it has no text for, and shortens a long one", () => {
		expect(describeRewind({ ...base, message: undefined }).startsWith("Rewind to before that message?")).toBe(true);
		expect(describeRewind({ ...base, message: "y".repeat(300) })).toContain(`"${"y".repeat(90)}…"`);
	});
});

describe("rewindChoices", () => {
	it("puts files and conversation last, as the primary choice", () => {
		expect(rewindChoices(base).map((c: { value: string }) => c.value)).toEqual(["conversation", "code", "both"]);
		expect(rewindChoices(base).at(-1)).toMatchObject({ value: "both", primary: true });
	});
});

describe("rewindTo", () => {
	const run = async (mode: string) => {
		const dispatched: Array<{ type: string; detail: { text: string } }> = [];
		vi.stubGlobal("window", { dispatchEvent: (e: { type: string; detail: { text: string } }) => dispatched.push(e) });
		vi.stubGlobal(
			"CustomEvent",
			class {
				constructor(
					public type: string,
					public init: { detail: { text: string } },
				) {}
				get detail() {
					return this.init.detail;
				}
			},
		);
		vi.mocked(api).mockReset().mockResolvedValueOnce(base).mockResolvedValueOnce({ result: "done" });
		const done = await rewindTo({
			id: "s1",
			userSeq: 3,
			confirm: async () => mode,
			addNotice: vi.fn(),
			showToast: vi.fn(),
			refresh: async () => {},
		});
		vi.unstubAllGlobals();
		return { done, dispatched };
	};

	it("hands the removed message back to the composer when the conversation was cut", async () => {
		const { done, dispatched } = await run("both");
		expect(done).toBe(true);
		expect(dispatched.map((e) => [e.type, e.detail.text])).toEqual([["cast:set-draft", "fix the bug"]]);
	});

	it("leaves the composer alone when only the files went back", async () => {
		const { dispatched } = await run("code");
		expect(dispatched).toEqual([]);
	});
});
