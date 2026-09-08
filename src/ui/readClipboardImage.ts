import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const NO_IMAGE_ON_CLIPBOARD_RE = /not available|no image|target.*unavailable/i;

export interface ClipboardImage {
	bytes: Buffer;
	mimeType: string;
}

export type ClipboardImageResult =
	| { ok: true; image: ClipboardImage }
	| { ok: false; error: string }
	| { ok: false; error: null };

/**
 * Whether the helper binary is simply not installed.
 *
 * This used to check only for `ENOENT`, while the commands ran through
 * `exec` — a shell, which reports a missing binary as exit 127 and never as
 * ENOENT. So the one message that names the fix ("install: brew install
 * pngpaste") could not be produced on any platform; the user got
 * `Couldn't read clipboard: Command failed: … /bin/sh: 1: xclip: not found`.
 * The calls use `execFile` now (no shell — the argv is fixed anyway), so
 * ENOENT is the real signal; 127 stays as a belt-and-braces check.
 */
function isCommandNotFound(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code: unknown = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === 127;
}

/**
 * Whether the tool ran fine and said the clipboard holds no image — a text
 * selection, most often. That is not an error to report: the caller has a
 * neutral "no image in clipboard" notice for it, and telling the user their
 * clipboard tool failed when they simply copied text is a wrong diagnosis.
 */
function isNoImageOnClipboard(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return NO_IMAGE_ON_CLIPBOARD_RE.test(text);
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
	const platform = process.platform;
	try {
		if (platform === "darwin") {
			const { stdout } = await execFileAsync("pngpaste", ["-"], {
				encoding: "buffer",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			if (!stdout || stdout.length === 0) return { ok: false, error: null };
			return { ok: true, image: { bytes: stdout as Buffer, mimeType: "image/png" } };
		}
		if (platform === "linux") {
			const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
				encoding: "buffer",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			if (!stdout || stdout.length === 0) return { ok: false, error: null };
			return { ok: true, image: { bytes: stdout as Buffer, mimeType: "image/png" } };
		}
		if (platform === "win32") {
			const ps =
				"Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
				"$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
				"if ($img) { " +
				"$ms = New-Object System.IO.MemoryStream; " +
				"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); " +
				"[Convert]::ToBase64String($ms.ToArray()) " +
				"}";
			const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", ps], {
				encoding: "utf-8",
				maxBuffer: MAX_IMAGE_BYTES,
			});
			const b64 = stdout.trim();
			if (!b64) return { ok: false, error: null };
			return { ok: true, image: { bytes: Buffer.from(b64, "base64"), mimeType: "image/png" } };
		}
		return { ok: false, error: `Clipboard image paste isn't supported on ${platform}.` };
	} catch (error) {
		if (platform === "darwin" && isCommandNotFound(error)) {
			return { ok: false, error: "pngpaste not found — install: brew install pngpaste" };
		}
		if (platform === "linux" && isCommandNotFound(error)) {
			return { ok: false, error: "xclip not found — install: apt install xclip" };
		}
		if (isNoImageOnClipboard(error)) return { ok: false, error: null };
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Couldn't read clipboard: ${message.slice(0, 200)}` };
	}
}

/**
 * `{ ok: true, path }`, or the reason there is no image.
 *
 * `error: null` means "the clipboard simply holds no image" — nothing to
 * report. A string is a real problem the user can act on (`pngpaste` not
 * installed, an unsupported platform), and it used to be thrown away: this
 * returned `string | null` and the caller rendered every null as "No image in
 * clipboard — copy a screenshot or image file first". pngpaste is not part of
 * macOS, so a Mac user with a screenshot on the clipboard was told their
 * clipboard was empty, every time, with the actual fix (`brew install
 * pngpaste`) computed one function away and discarded.
 */
export type ClipboardPasteResult = { ok: true; path: string } | { ok: false; error: string | null };

export async function saveClipboardImageToTempFile(): Promise<ClipboardPasteResult> {
	const result = await readClipboardImage();
	if (!result.ok) return { ok: false, error: result.error };
	if (!result.image) return { ok: false, error: null };

	const ext = result.image.mimeType === "image/jpeg" ? "jpg" : "png";
	const filePath = join(tmpdir(), `cast-clipboard-${randomUUID()}.${ext}`);
	// 0600: /tmp is shared, and a pasted screenshot is whatever was on screen.
	writeFileSync(filePath, result.image.bytes, { mode: 0o600 });
	return { ok: true, path: filePath };
}
