/**
 * Pasting an image in the TUI. The diagnosis matters more than the mechanism
 * here: pngpaste is not part of macOS and xclip is not part of most Linux
 * images, so "the helper is missing" is the *common* first experience — and it
 * used to be reported as "no image in clipboard", which sends the user looking
 * for a problem with their clipboard instead of installing one binary.
 */
import { existsSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

const { readClipboardImage, saveClipboardImageToTempFile } = await import("../src/ui/readClipboardImage.ts");

/** promisify() calls the mocked execFile with a trailing callback. */
function respond(handler: (file: string, args: string[]) => { stdout?: unknown } | Error): void {
	execFileMock.mockImplementation((file: string, args: string[], _opts: unknown, cb: unknown) => {
		const callback = cb as (err: unknown, out?: { stdout: unknown; stderr: string }) => void;
		const outcome = handler(file, args);
		if (outcome instanceof Error) callback(outcome);
		else callback(null, { stdout: outcome.stdout, stderr: "" });
	});
}

describe("readClipboardImage", () => {
	it("names the missing helper instead of blaming the clipboard", async () => {
		// A shell reports a missing binary as exit 127, never ENOENT — which is
		// why this message was unreachable while the call went through `exec`.
		respond(() => Object.assign(new Error("Command failed: xclip …"), { code: 127 }));

		const result = await readClipboardImage();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(process.platform === "linux" ? /xclip not found/ : /not found|isn't supported/);
	});

	it("reports plain text on the clipboard as 'no image', not as a failure", async () => {
		respond(() => Object.assign(new Error("Error: target image/png not available"), { code: 1 }));

		const result = await readClipboardImage();

		expect(result).toEqual({ ok: false, error: null });
	});
});

describe("saveClipboardImageToTempFile", () => {
	it("passes the actionable error through to the caller", async () => {
		respond(() => Object.assign(new Error("Command failed"), { code: 127 }));

		const result = await saveClipboardImageToTempFile();

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// A string, not null: the caller renders null as "no image in clipboard".
		expect(typeof result.error).toBe("string");
	});

	it("writes the image where only this user can read it", async () => {
		if (process.platform === "win32") return;
		respond(() => ({ stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));

		const result = await saveClipboardImageToTempFile();

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(existsSync(result.path)).toBe(true);
		// /tmp is shared; a pasted screenshot is whatever was on the screen.
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
	});
});
