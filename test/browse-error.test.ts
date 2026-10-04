import { describe, expect, it } from "vitest";
import { browseErrorText } from "../src/server/browse-error.ts";

const withCode = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("browseErrorText", () => {
	it("says what happened without the system call or the path", () => {
		expect(browseErrorText(withCode("ENOTEMPTY", "ENOTEMPTY: directory not empty, rmdir '/very/long/path'"))).toBe(
			"The folder isn't empty, so it was not deleted",
		);
		expect(browseErrorText(withCode("EACCES", "EACCES: permission denied, scandir '/root'"))).toBe(
			"Permission denied",
		);
		expect(browseErrorText(withCode("EPERM", "EPERM: operation not permitted"))).toBe("Permission denied");
		expect(browseErrorText(withCode("ENOENT", "ENOENT: no such file or directory, stat '/nope'"))).toBe(
			"That folder doesn't exist",
		);
		expect(browseErrorText(withCode("ENOTDIR", "Not a directory"))).toBe("That is not a folder");
		expect(browseErrorText(withCode("EEXIST", "EEXIST: file already exists, mkdir '/a/b'"))).toBe(
			"A folder with that name already exists",
		);
	});

	it("passes any other error through", () => {
		expect(browseErrorText(new Error("disk on fire"))).toBe("disk on fire");
		expect(browseErrorText("plain")).toBe("plain");
	});
});
