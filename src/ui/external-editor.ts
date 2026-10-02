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
	// The draft may hold a secret, and the temp folder is shared: readable by the person alone.
	try {
		writeFileSync(file, draft, { mode: 0o600 });
	} catch (error) {
		return {
			ok: false,
			error: `Could not write the draft for the editor: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		// Through the shell: $EDITOR is a command line, often with flags
		// (`code --wait`, `emacsclient -t`).
		const run = await suspendAndRun(async () =>
			spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit", env }),
		);
		if (run.error) return { ok: false, error: `Could not start ${editor}: ${run.error.message}` };
		// Through the shell a stopped editor shows as 128 plus the signal, not as a signal.
		const signal =
			run.signal ??
			(run.status !== null && run.status > 128 && run.status < 160 ? `signal ${run.status - 128}` : undefined);
		if (signal) return { ok: false, error: `${editor} was stopped (${signal}); draft unchanged` };
		if (run.status !== 0) return { ok: false, error: `${editor} exited with code ${run.status}; draft unchanged` };
		// Editors end the file with a newline the draft never had.
		return { ok: true, text: readFileSync(file, "utf-8").replace(TRAILING_NEWLINE_RE, "") };
	} finally {
		rmSync(file, { force: true });
	}
}
