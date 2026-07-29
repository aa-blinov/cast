import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a session's attached (non-image) documents live: `~/.cast/inputs/
 * <session-id>/` — global, not inside the session's own cwd. Keeping it out
 * of the project tree means an attached file never risks landing in the
 * user's git history (no .gitignore cooperation needed) and never collides
 * with a later session started fresh in that same directory (each session
 * id gets its own folder regardless of cwd). Flat by design — attachments
 * aren't expected to need subdirectories, so callers never have to handle
 * nested paths, only filenames.
 */
export function sessionInputsDir(sessionId: string): string {
	return join(homedir(), ".cast", "inputs", sessionId);
}
