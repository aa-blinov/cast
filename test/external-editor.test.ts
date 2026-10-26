import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editInExternalEditor } from "../src/ui/external-editor.ts";

function makeEditor(source: string): { command: string; cleanup: () => void } {
	const script = join(tmpdir(), `cast-editor-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
	writeFileSync(script, source);
	return {
		command: `"${process.execPath}" "${script}"`,
		cleanup: () => rmSync(script, { force: true }),
	};
}

describe("editInExternalEditor", () => {
	it("returns what the editor saved, without the trailing newline editors add", async () => {
		// A stand-in editor: appends a line to the file it's given.
		const editor = makeEditor('require("node:fs").appendFileSync(process.argv[2], "\\nsecond line\\n");');
		try {
			const env = { ...process.env, VISUAL: "", EDITOR: editor.command };
			expect(await editInExternalEditor("first line", env)).toEqual({ ok: true, text: "first line\nsecond line" });
		} finally {
			editor.cleanup();
		}
	});

	it("prefers $VISUAL over $EDITOR", async () => {
		const editor = makeEditor('require("node:fs").writeFileSync(process.argv[2], "visual");');
		const fallback = makeEditor("process.exit(1);");
		try {
			const env = { ...process.env, VISUAL: editor.command, EDITOR: fallback.command };
			expect(await editInExternalEditor("draft", env)).toEqual({ ok: true, text: "visual" });
		} finally {
			editor.cleanup();
			fallback.cleanup();
		}
	});

	it("keeps the draft when the editor fails or none is set", async () => {
		const editor = makeEditor("process.exit(1);");
		try {
			const failed = await editInExternalEditor("draft", { ...process.env, VISUAL: "", EDITOR: editor.command });
			expect(failed.ok).toBe(false);
			const unset = await editInExternalEditor("draft", { ...process.env, VISUAL: "", EDITOR: "" });
			expect(unset).toEqual({ ok: false, error: "Set $VISUAL or $EDITOR to edit the prompt in an editor" });
		} finally {
			editor.cleanup();
		}
	});

	it.skipIf(process.platform === "win32")(
		"gives the editor a file only the person can read, since a draft may hold a secret",
		async () => {
			const seen = join(tmpdir(), `cast-editor-mode-${process.pid}.txt`);
			const editor = makeEditor(
				`require("node:fs").writeFileSync(${JSON.stringify(seen)}, String((require("node:fs").statSync(process.argv[2]).mode & 0o777).toString(8)));`,
			);
			try {
				const env = { ...process.env, VISUAL: "", EDITOR: editor.command };
				await editInExternalEditor("secret", env);
				expect(readFileSync(seen, "utf8").trim()).toBe("600");
			} finally {
				editor.cleanup();
				rmSync(seen, { force: true });
			}
		},
	);

	it("says so when the editor is stopped by a signal, rather than 'exited with code null'", async () => {
		const editor = makeEditor("process.exit(143);");
		try {
			const env = { ...process.env, VISUAL: "", EDITOR: editor.command };
			const result = await editInExternalEditor("draft", env);
			expect(result.ok).toBe(false);
			// A shell killed by the signal reports it as a signal; a shell that
			// exits with 128+signal reports the number. Both say the same thing.
			expect(result.ok ? "" : result.error).toMatch(/was stopped \(signal 15\)/);
		} finally {
			editor.cleanup();
		}
	});
});
