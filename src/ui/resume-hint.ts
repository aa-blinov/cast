import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How to get back, as a command: a session that had a turn names itself; an empty one (nothing was said, or
 * the conversation was cleared with /clear or /new) points to the folder's earlier sessions if there are any.
 */
export function resumeCommand(
	session: { id: string; hasMessages: boolean },
	earlierInThisFolder: boolean,
): string | undefined {
	if (session.hasMessages) return `cast --resume=${session.id}`;
	if (earlierInThisFolder) return "cast --continue";
	return undefined;
}

/**
 * The line printed after the screen is gone, since the exit clears the session id along with the rest of
 * the frame.
 */
export function resumeHint(
	session: { id: string; hasMessages: boolean },
	earlierInThisFolder: boolean,
): string | undefined {
	const command = resumeCommand(session, earlierInThisFolder);
	if (!command) return undefined;
	if (session.hasMessages) return `\x1b[2mResume this session:\x1b[22m ${command}`;
	return `\x1b[2mEarlier session in this folder:\x1b[22m ${command}  (or cast --resume to pick)`;
}

/** Where the command is left for the shell function from `cast shell-init`, which adds it to the shell's history. */
export function lastResumePath(): string {
	return join(process.env.CAST_HOME ?? join(homedir(), ".cast"), "last-resume");
}

/** Leaves `command` for the shell function, or clears an old one when there is none. Never throws: this runs while exiting. */
export function writeLastResume(command: string | undefined): void {
	const path = lastResumePath();
	try {
		if (command === undefined) {
			rmSync(path, { force: true });
			return;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${command}\n`);
	} catch {
		// A history entry is a convenience; the printed line is still there.
	}
}

export const SHELLS = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

/** The shell a function should be written for: the name given, else the login shell. */
export function detectShell(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): Shell | undefined {
	const name = arg ?? env.SHELL?.split("/").pop();
	return SHELLS.find((shell) => shell === name);
}

/**
 * A `cast` function that runs the real one and then puts the resume command in the shell's history, so Up
 * brings it back. A child process cannot write its parent's history, which is why this lives in the shell.
 * The file is removed before the run, so an entry left by some other run is never replayed, and only an interactive exit writes it, so `cast run` and the other subcommands add nothing.
 */
export function shellInit(shell: Shell): string {
	if (shell === "fish") {
		return `function cast
    set -l f (set -q CAST_HOME; and echo $CAST_HOME; or echo $HOME/.cast)/last-resume
    rm -f $f
    command cast $argv
    set -l rc $status
    if test -f $f
        set -l line (cat $f)
        rm -f $f
        test -n "$line"; and builtin history append -- $line
    end
    return $rc
end
`;
	}
	const read = `    if [ -f "$f" ]; then
        line=$(cat "$f"); rm -f "$f"
        [ -n "$line" ] && ${shell === "zsh" ? 'print -s -- "$line"' : 'history -s -- "$line"'}
    fi`;
	return `cast() {
    local f="\${CAST_HOME:-$HOME/.cast}/last-resume" line rc
    rm -f "$f"
    command cast "$@"
    rc=$?
${read}
    return $rc
}
`;
}
