/**
 * Tab completion in the composer. The guard matters as much as the matching:
 * with no popup to dismiss, a completion the user did not ask for is worse
 * than none, so only path-shaped tokens complete at all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completePath } from "../src/ui/input/path-complete.ts";

let dir: string;
let home: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-complete-"));
	mkdirSync(join(dir, "src", "ui"), { recursive: true });
	writeFileSync(join(dir, "src", "index.ts"), "");
	writeFileSync(join(dir, "src", "ui", "Composer.tsx"), "");
	writeFileSync(join(dir, "src", "ui", "ChatLog.tsx"), "");
	writeFileSync(join(dir, ".hidden"), "");
	home = process.env.HOME;
});

afterEach(() => {
	if (home === undefined) delete process.env.HOME;
	else process.env.HOME = home;
	rmSync(dir, { recursive: true, force: true });
});

const complete = (text: string) => completePath(text, text.length, dir);

describe("completePath", () => {
	it("finishes an unambiguous file name", () => {
		const result = complete("посмотри src/ui/Comp");
		expect(result).toMatchObject({ insert: "Composer.tsx", candidates: ["Composer.tsx"] });
		// Only the base name is replaced, never the directory in front of it.
		expect(result && "посмотри src/ui/Comp".slice(0, result.from)).toBe("посмотри src/ui/");
	});

	it("commits the shared prefix when several names still match", () => {
		const result = complete("src/ui/C");
		expect(result?.insert).toBe("C");
		expect(result?.candidates).toEqual(["ChatLog.tsx", "Composer.tsx"]);
	});

	it("marks a directory with a trailing slash so the next Tab descends", () => {
		const result = complete("./sr");
		expect(result?.insert).toBe("src/");
	});

	it("leaves prose alone — a token has to look like a path", () => {
		expect(complete("посмотри")).toBeNull();
		expect(complete("src")).toBeNull();
		expect(complete("")).toBeNull();
	});

	it("hides dotfiles until the dot is typed", () => {
		expect(complete("./")?.candidates).toEqual(["src/"]);
		expect(complete("./.h")?.candidates).toEqual([".hidden"]);
	});

	it("expands ~ against HOME", () => {
		process.env.HOME = dir;
		expect(complete("~/sr")?.insert).toBe("src/");
	});

	it("returns null for a directory that isn't there instead of throwing", () => {
		expect(complete("nope/whatever/x")).toBeNull();
	});

	it("completes an absolute path", () => {
		const text = `${join(dir, "src", "ui", "Chat")}`;
		expect(completePath(text, text.length, "/")?.insert).toBe("ChatLog.tsx");
	});
});
