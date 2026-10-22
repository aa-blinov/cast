import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("gives the editor a file only the person can read, since a draft may hold a secret", async () => {
		const seen = join(tmpdir(), `cast-editor-mode-${process.pid}.txt`);
		// GNU stat spells the mode `stat -c %a`, BSD stat (macOS) `stat -f %Lp`.
		const env = {
			...process.env,
			VISUAL: "",
			EDITOR: `sh -c 'mode=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null); printf "%s" "$mode" > "${seen}"' sh`,
		};
		try {
			await editInExternalEditor("secret", env);
			expect(readFileSync(seen, "utf8").trim()).toBe("600");
		} finally {
			rmSync(seen, { force: true });
		}
	});

	it("says so when the editor is stopped by a signal, rather than 'exited with code null'", async () => {
		const env = { ...process.env, VISUAL: "", EDITOR: `sh -c 'kill -TERM $$' sh` };
		const result = await editInExternalEditor("draft", env);
		expect(result.ok).toBe(false);
		// A shell killed by the signal reports it as a signal; a shell that
		// exits with 128+signal reports the number. Both say the same thing.
		expect(result.ok ? "" : result.error).toMatch(/was stopped \((signal 15|SIGTERM)\)/);
	});
});
