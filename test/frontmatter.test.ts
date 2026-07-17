import { describe, expect, it } from "vitest";
import {
	matchesToolsAllowlist,
	parseAgentsMd,
	parseFrontmatter,
	parseToolsAllowlist,
} from "../src/core/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("returns empty frontmatter and the whole content as body when there's no block", () => {
		const { frontmatter, body } = parseFrontmatter("just a body\nmore text");
		expect(frontmatter).toEqual({});
		expect(body).toBe("just a body\nmore text");
	});

	it("treats an unterminated --- block as no frontmatter (body = whole)", () => {
		const input = "---\nname: x\nno closing fence";
		const { frontmatter, body } = parseFrontmatter(input);
		expect(frontmatter).toEqual({});
		expect(body).toBe(input);
	});

	it("parses scalar fields and strips the block from the body", () => {
		const { frontmatter, body } = parseFrontmatter("---\nname: hello\ndescription: a thing\n---\nBody here.");
		expect(frontmatter).toEqual({ name: "hello", description: "a thing" });
		expect(body).toBe("Body here.");
	});

	it("coerces true/false to booleans but leaves other words as strings", () => {
		const { frontmatter } = parseFrontmatter("---\na: true\nb: false\nc: truthy\n---\n");
		expect(frontmatter).toEqual({ a: true, b: false, c: "truthy" });
	});

	it("parses inline arrays, quoted or bare, and an empty array", () => {
		const { frontmatter } = parseFrontmatter('---\nglobs: ["*.ts", "*.tsx"]\ntags: [a, b]\nempty: []\n---\n');
		expect(frontmatter.globs).toEqual(["*.ts", "*.tsx"]);
		expect(frontmatter.tags).toEqual(["a", "b"]);
		expect(frontmatter.empty).toEqual([]);
	});

	it("strips surrounding single or double quotes from scalar values", () => {
		const { frontmatter } = parseFrontmatter(`---\na: "quoted"\nb: 'single'\n---\n`);
		expect(frontmatter).toEqual({ a: "quoted", b: "single" });
	});

	it("keeps everything after the first colon as the value (URLs, colons in text)", () => {
		const { frontmatter } = parseFrontmatter("---\nurl: https://example.com/v1\nnote: a: b\n---\n");
		expect(frontmatter.url).toBe("https://example.com/v1");
		expect(frontmatter.note).toBe("a: b");
	});

	it("skips lines that aren't key: value", () => {
		const { frontmatter } = parseFrontmatter("---\nname: ok\nthis is not a field\n# comment-ish\n---\n");
		expect(frontmatter).toEqual({ name: "ok" });
	});

	it("normalizes CRLF and drops the leading newline of the body", () => {
		const { frontmatter, body } = parseFrontmatter("---\r\nname: x\r\n---\r\nline1\r\nline2");
		expect(frontmatter).toEqual({ name: "x" });
		expect(body).toBe("line1\nline2");
	});

	it("accepts hyphens, underscores and digits in keys", () => {
		const { frontmatter } = parseFrontmatter("---\nmax-tokens: 5\nsome_key: v\nkey2: w\n---\n");
		expect(frontmatter).toEqual({ "max-tokens": "5", some_key: "v", key2: "w" });
	});
});

describe("parseToolsAllowlist", () => {
	it("returns undefined when tools is omitted", () => {
		expect(parseToolsAllowlist({})).toBeUndefined();
	});

	it("parses an inline tools array", () => {
		const { frontmatter } = parseFrontmatter("---\ntools: [read, grep, ls]\n---\n");
		expect(parseToolsAllowlist(frontmatter)).toEqual(["read", "grep", "ls"]);
	});

	it("keeps an explicit empty array (no tools)", () => {
		const { frontmatter } = parseFrontmatter("---\ntools: []\n---\n");
		expect(parseToolsAllowlist(frontmatter)).toEqual([]);
	});

	it("treats a non-array tools value as omitted", () => {
		const { frontmatter } = parseFrontmatter("---\ntools: true\n---\n");
		expect(parseToolsAllowlist(frontmatter)).toBeUndefined();
	});
});

describe("parseAgentsMd", () => {
	it("defaults to true when omitted", () => {
		expect(parseAgentsMd({})).toBe(true);
	});

	it("returns false only for explicit false", () => {
		const { frontmatter } = parseFrontmatter("---\nagentsMd: false\n---\n");
		expect(parseAgentsMd(frontmatter)).toBe(false);
	});

	it("returns true for explicit true", () => {
		const { frontmatter } = parseFrontmatter("---\nagentsMd: true\n---\n");
		expect(parseAgentsMd(frontmatter)).toBe(true);
	});
});

describe("matchesToolsAllowlist", () => {
	it("matches exact names", () => {
		expect(matchesToolsAllowlist("read", ["read", "grep"])).toBe(true);
		expect(matchesToolsAllowlist("bash", ["read", "grep"])).toBe(false);
	});

	it("matches plan_* and web_* globs", () => {
		const patterns = ["read", "plan_*", "web_*"];
		expect(matchesToolsAllowlist("plan_write", patterns)).toBe(true);
		expect(matchesToolsAllowlist("plan_done", patterns)).toBe(true);
		expect(matchesToolsAllowlist("web_search", patterns)).toBe(true);
		expect(matchesToolsAllowlist("web_fetch", patterns)).toBe(true);
		expect(matchesToolsAllowlist("bash", patterns)).toBe(false);
		expect(matchesToolsAllowlist("write", patterns)).toBe(false);
	});

	it("treats bare * as match-all", () => {
		expect(matchesToolsAllowlist("bash", ["*"])).toBe(true);
		expect(matchesToolsAllowlist("plan_check", ["*"])).toBe(true);
	});

	it("does not match names outside the glob prefix", () => {
		expect(matchesToolsAllowlist("planning", ["plan_*"])).toBe(false);
		expect(matchesToolsAllowlist("my_plan_write", ["plan_*"])).toBe(false);
	});
});
