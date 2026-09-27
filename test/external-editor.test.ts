import { describe, expect, it } from "vitest";
import { editInExternalEditor } from "../src/ui/external-editor.ts";

describe("editInExternalEditor", () => {
	it("returns what the editor saved, without the trailing newline editors add", async () => {
		// A stand-in editor: appends a line to the file it's given.
		const env = { ...process.env, VISUAL: "", EDITOR: `sh -c 'printf "\\nsecond line\\n" >> "$1"' sh` };
		expect(await editInExternalEditor("first line", env)).toEqual({ ok: true, text: "first line\nsecond line" });
	});

	it("prefers $VISUAL over $EDITOR", async () => {
		const env = { ...process.env, VISUAL: `sh -c 'printf visual > "$1"' sh`, EDITOR: "false" };
		expect(await editInExternalEditor("draft", env)).toEqual({ ok: true, text: "visual" });
	});

	it("keeps the draft when the editor fails or none is set", async () => {
		const failed = await editInExternalEditor("draft", { ...process.env, VISUAL: "", EDITOR: "false" });
		expect(failed.ok).toBe(false);
		const unset = await editInExternalEditor("draft", { ...process.env, VISUAL: "", EDITOR: "" });
		expect(unset).toEqual({ ok: false, error: "Set $VISUAL or $EDITOR to edit the prompt in an editor" });
	});
});
