/**
 * Edit the composer draft in $VISUAL / $EDITOR, the way `git commit` does:
 * the draft goes to a temp file, the TUI steps aside while the editor owns
 * the terminal, and whatever is saved comes back as the new draft.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspendAndRun } from "../core/stdin-manager.ts";

const TRAILING_NEWLINE_RE = /\r?\n$/;

export type EditorResult = { ok: true; text: string } | { ok: false; error: string };

export async function editInExternalEditor(draft: string, env: NodeJS.ProcessEnv = process.env): Promise<EditorResult> {
	const editor = env.VISUAL?.trim() || env.EDITOR?.trim();
	if (!editor) return { ok: false, error: "Set $VISUAL or $EDITOR to edit the prompt in an editor" };
	const file = join(tmpdir(), `cast-prompt-${process.pid}-${Date.now()}.md`);
	writeFileSync(file, draft);
	try {
		// Through the shell: $EDITOR is a command line, often with flags
		// (`code --wait`, `emacsclient -t`).
		const run = await suspendAndRun(async () =>
			spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit", env }),
		);
		if (run.error) return { ok: false, error: `Could not start ${editor}: ${run.error.message}` };
		if (run.status !== 0) return { ok: false, error: `${editor} exited with code ${run.status}; draft unchanged` };
		// Editors end the file with a newline the draft never had.
		return { ok: true, text: readFileSync(file, "utf-8").replace(TRAILING_NEWLINE_RE, "") };
	} finally {
		rmSync(file, { force: true });
	}
}
