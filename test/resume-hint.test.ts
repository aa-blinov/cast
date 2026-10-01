import { describe, expect, it } from "vitest";
import { resumeHint } from "../src/ui/resume-hint.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string | undefined) => line?.replace(/\x1b\[[0-9;]*m/g, "");

describe("resumeHint", () => {
	it("names a session that had a turn, whether or not there are earlier ones", () => {
		expect(plain(resumeHint({ id: "abc", hasMessages: true }, false))).toBe("Resume this session: cast --resume=abc");
		expect(plain(resumeHint({ id: "abc", hasMessages: true }, true))).toBe("Resume this session: cast --resume=abc");
	});

	it("points an empty session to the folder's earlier ones, for a cleared or never-used conversation", () => {
		expect(plain(resumeHint({ id: "abc", hasMessages: false }, true))).toBe(
			"Earlier session in this folder: cast --continue  (or cast --resume to pick)",
		);
	});

	it("says nothing when there is nothing to go back to", () => {
		expect(resumeHint({ id: "abc", hasMessages: false }, false)).toBeUndefined();
	});
});
