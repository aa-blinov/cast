import { homedir } from "node:os";
import { basename, join } from "node:path";

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
	if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
	return join(homedir(), ".cast", "inputs", sessionId);
}

/**
 * Whether a session id is safe to use as a single path segment.
 *
 * Session ids are generated as `[a-z0-9]+` (see core/session.ts), but they
 * arrive here straight out of a URL path parameter, and the router's `([^/]+)`
 * happily matches `..` — which Node never normalizes out of `req.url`. Without
 * this check `join(~/.cast/inputs, "..")` resolves to `~/.cast` itself, so
 * `DELETE /api/sessions/../permanent` handed the whole cast home directory
 * (settings with provider keys, sessions.db, keys/, skills/, plugins/) to a
 * recursive `rmSync` and still answered a misleading 404.
 *
 * Deliberately a bit looser than the generator's own alphabet — an id can also
 * come from an outside caller (ACP, an import) — while still admitting nothing
 * that means anything to the filesystem.
 */
export function isSafeSessionId(sessionId: string): boolean {
	return SAFE_SESSION_ID_RE.test(sessionId);
}

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a string may be used as one path segment: non-empty, no separator,
 * and not a relative-directory reference. Looser than isSafeSessionId because
 * the names it guards (plugin and marketplace slugs) legitimately contain dots
 * and other punctuation — it only rules out anything that would let a name
 * escape the directory it's being joined into.
 */
export function isSafePathSegment(segment: string): boolean {
	if (!segment || segment === "." || segment === "..") return false;
	return !segment.includes("/") && !segment.includes("\\") && basename(segment) === segment;
}

/**
 * Executable/binary formats rejected as a document attachment — the model
 * would only ever be asked to *read* an attachment (via `read`/`bash` or a
 * format-specific skill), never run it, so there's no legitimate reason to
 * accept something whose only real use is being executed. Archives (zip,
 * tar, 7z, ...) and ordinary documents (pdf, docx, csv, ...) are explicitly
 * NOT on this list — those are exactly what this feature exists for.
 * Extension-based, not magic-byte sniffing: good enough to stop someone
 * dragging in an .exe by mistake or on purpose, not a hardened sandbox
 * boundary (the file is never executed by anything cast does either way).
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
	"exe",
	"msi",
	"dll",
	"so",
	"dylib",
	"bin",
	"com",
	"bat",
	"cmd",
	"scr",
	"vbs",
	"vbe",
	"ps1",
	"psm1",
	"jar",
	"app",
	"deb",
	"rpm",
	"apk",
	"run",
	"out",
	"elf",
	"cpl",
	"gadget",
	"wsf",
	"wsh",
	"ocx",
	"sys",
	"action",
	"workflow",
	"command",
]);

/** Lowercased extension without the dot, or "" if the name has none. */
export function extensionOf(name: string): string {
	const idx = name.lastIndexOf(".");
	return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

/** True if this filename's extension is on the executable/binary blocklist. */
export function isBlockedAttachmentName(name: string): boolean {
	return BLOCKED_ATTACHMENT_EXTENSIONS.has(extensionOf(name));
}
