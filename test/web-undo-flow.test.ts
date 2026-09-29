import { describe, expect, it, vi } from "vitest";

vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }), { virtual: true });

const { describeUndo } = await import("../src/server/public/undo-flow.js");

describe("describeUndo", () => {
	it("names the message that goes and how many messages go with it", () => {
		const text = describeUndo({
			available: true,
			kind: "snapshot",
			shellChangesCovered: true,
			removedMessage: "fix the bug",
			removedMessages: 4,
			lostTotal: 0,
			lost: [],
		});
		expect(text).toContain('Your message "fix the bug" and the 4 messages from it on are removed.');
		expect(text).toContain("Every file in the folder goes back");
		expect(text).not.toContain("shell commands");
		expect(text).not.toContain("also deletes");
	});

	it("says 'message' for one, and copes with no user message at all", () => {
		expect(describeUndo({ kind: "git", removedMessage: "x", removedMessages: 1, lostTotal: 0, lost: [] })).toContain(
			"and the message from it on",
		);
		expect(describeUndo({ kind: "git", lostTotal: 0, lost: [] }).startsWith("Undo the last turn?\n\n")).toBe(true);
	});

	it("warns that shell changes stay when the folder was too big to snapshot", () => {
		const text = describeUndo({
			kind: "files",
			shellChangesCovered: false,
			removedMessage: "x",
			removedMessages: 2,
			lostTotal: 0,
			lost: [],
		});
		expect(text).toContain("Files changed with edit or write are put back.");
		expect(text).toContain("changes made by shell commands are not undone");
	});

	it("lists the files it deletes, shortened past six", () => {
		const some = describeUndo({ kind: "git", lostTotal: 2, lost: ["a.txt", "b.txt"] });
		expect(some).toContain("also deletes 2 files created since");
		expect(some).toContain("a.txt, b.txt.");
		const many = describeUndo({ kind: "git", lostTotal: 9, lost: ["1", "2", "3", "4", "5", "6", "7", "8"] });
		expect(many).toContain("1, 2, 3, 4, 5, 6 and 3 more.");
		expect(describeUndo({ kind: "git", lostTotal: 1, lost: ["x"] })).toContain("deletes 1 file created");
	});

	it("quotes a long message shortened", () => {
		const text = describeUndo({
			kind: "git",
			removedMessage: "x".repeat(300),
			removedMessages: 2,
			lostTotal: 0,
			lost: [],
		});
		expect(text).toContain(`"${"x".repeat(90)}…"`);
		expect(text).not.toContain("x".repeat(91));
	});
});
