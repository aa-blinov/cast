import { describe, expect, it } from "vitest";
import { extensionOf, isBlockedAttachmentName, sessionInputsDir } from "../src/server/inputs.ts";

describe("sessionInputsDir", () => {
	it("is keyed by session id, not by cwd — a stable location regardless of where the session runs", () => {
		const a = sessionInputsDir("session-aaa");
		const b = sessionInputsDir("session-bbb");
		expect(a).not.toBe(b);
		expect(a).toContain("session-aaa");
		expect(a).toContain(".cast");
		expect(a).toContain("inputs");
	});

	it("is deterministic for the same session id", () => {
		expect(sessionInputsDir("same-id")).toBe(sessionInputsDir("same-id"));
	});
});

describe("extensionOf", () => {
	it("returns the lowercased extension without the dot", () => {
		expect(extensionOf("Report.PDF")).toBe("pdf");
		expect(extensionOf("archive.tar.gz")).toBe("gz");
	});

	it("returns an empty string for a name with no extension", () => {
		expect(extensionOf("README")).toBe("");
		expect(extensionOf("")).toBe("");
	});
});

describe("isBlockedAttachmentName", () => {
	it("blocks common executable/binary formats regardless of case", () => {
		for (const name of ["setup.exe", "installer.MSI", "lib.dll", "tool.bin", "run.bat"]) {
			expect(isBlockedAttachmentName(name)).toBe(true);
		}
	});

	it("allows archives — explicitly not on the blocklist", () => {
		for (const name of ["project.zip", "backup.tar.gz", "data.7z", "files.rar"]) {
			expect(isBlockedAttachmentName(name)).toBe(false);
		}
	});

	it("allows ordinary documents", () => {
		for (const name of ["report.pdf", "notes.docx", "sheet.xlsx", "data.csv", "readme.md", "plain.txt"]) {
			expect(isBlockedAttachmentName(name)).toBe(false);
		}
	});

	it("allows a name with no extension at all", () => {
		expect(isBlockedAttachmentName("Dockerfile")).toBe(false);
	});
});
