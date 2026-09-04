/**
 * The built-in skills, checked against the Agent Skills spec cast claims to
 * follow (https://agentskills.io, mirrored in Claude Code's skills reference)
 * and against each other.
 *
 * Two classes of problem this catches: frontmatter fields outside the spec —
 * which make a skill fail packaging/upload with a hard error rather than being
 * ignored — and a skill telling the model to invoke another skill that does
 * not exist here, which costs the model a step and a failed tool call.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import { loadSkills } from "../src/core/skills.ts";

const BUILTIN_DIR = join(import.meta.dirname, "..", "prompts", "skills");

/** Fields the Agent Skills spec allows anywhere a skill can be distributed. */
const SPEC_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
/** Claude Code's documented extensions, valid in a skill loaded from disk. */
const EXTENSION_FIELDS = new Set([
	"when_to_use",
	"argument-hint",
	"arguments",
	"disable-model-invocation",
	"user-invocable",
	"disallowed-tools",
	"model",
	"effort",
	"context",
	"agent",
	"background",
	"hooks",
	"paths",
	"shell",
]);

const skillDirs = readdirSync(BUILTIN_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

describe("built-in skills follow the Agent Skills spec", () => {
	it.each(skillDirs)("%s declares only spec or documented-extension fields", (dir) => {
		const raw = readFileSync(join(BUILTIN_DIR, dir, "SKILL.md"), "utf-8");
		const { frontmatter } = parseFrontmatter(raw);
		const unknown = Object.keys(frontmatter).filter((key) => !SPEC_FIELDS.has(key) && !EXTENSION_FIELDS.has(key));
		// Packaging or uploading a skill with an unknown key fails outright:
		// "Unexpected key(s) in SKILL.md frontmatter". Put your own data under
		// `metadata`, and environment requirements under `compatibility`.
		expect(unknown).toEqual([]);
	});

	it("all load without diagnostics", () => {
		const { skills, diagnostics } = loadSkills({ builtinDir: BUILTIN_DIR, extraPaths: [] });
		expect(diagnostics).toEqual([]);
		expect(skills.length).toBe(skillDirs.length);
	});
});

describe("built-in skills reference each other by names that exist", () => {
	it("names no skill cast does not ship", () => {
		const available = new Set(skillDirs);
		const dangling: string[] = [];
		for (const dir of skillDirs) {
			const body = readFileSync(join(BUILTIN_DIR, dir, "SKILL.md"), "utf-8");
			for (const match of body.matchAll(/`([a-z0-9:-]+)`\s+skill/g)) {
				const referenced = match[1]!;
				if (!available.has(referenced)) dangling.push(`${dir} -> ${referenced}`);
			}
		}
		// e.g. `superpowers:test-driven-development` (another ecosystem's name
		// for cast's own `tdd`) and `code-review` (a Claude Code bundled skill
		// cast doesn't ship) both used to appear here.
		expect(dangling).toEqual([]);
	});
});
