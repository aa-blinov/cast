import { describe, expect, it } from "vitest";
import {
	buildCheckpointRepairPrompt,
	validateCheckpointArtifacts,
	validateCheckpointDocument,
	validateMemoryDocument,
	validateTaskProgressDocument,
} from "../src/core/checkpoint-validation.ts";

const validCheckpoint = `# Session checkpoint

## §1 Active intent
(none yet)

## §2 Next concrete action
(none yet)

## §3 Directives (this session)
(none)

## §4 Task tree
(none yet)

## §5 Current work
(none yet)

## §6 Files and code sections
(none yet)

## §7 Discovered knowledge (cross-task)
(none yet)

## §8 Errors and fixes
(none)

## §9 Live resources
(none yet)

## §10 Design decisions and discussion outcomes
(none yet)

## §11 Open notes
(none yet)
`;

const validMemory = `# Project memory

## Project context
(none yet)

## Rules
(none yet)

## Architecture decisions
(none yet)

## Discovered durable knowledge
(none yet)
`;

describe("checkpoint validation", () => {
	it("accepts the shipped empty artifact templates", () => {
		expect(validateCheckpointDocument(validCheckpoint, "checkpoint.md")).toEqual([]);
		expect(validateMemoryDocument(validMemory, "MEMORY.md")).toEqual([]);
	});

	it("reports missing, reordered, and duplicate sections", () => {
		const duplicate = validCheckpoint.replace(
			"## §6 Files and code sections",
			"## §6 Files and code sections\n\n## §6 Files and code sections",
		);
		const reordered = validCheckpoint
			.replace("## §5 Current work", "## §6 TEMPORARY_FILES_SECTION")
			.replace("## §6 Files and code sections", "## §5 Current work")
			.replace("## §6 TEMPORARY_FILES_SECTION", "## §6 Files and code sections");
		expect(validateCheckpointDocument(duplicate, "checkpoint.md").map((issue) => issue.rule)).toContain(
			"duplicate-section",
		);
		expect(validateCheckpointDocument(reordered, "checkpoint.md").map((issue) => issue.rule)).toContain(
			"section-out-of-order",
		);
	});

	it("validates all artifacts and builds a bounded repair instruction", () => {
		const issues = validateCheckpointArtifacts({
			checkpoint: "# Session checkpoint\n## §1 Active intent\n",
			memory: validMemory.replace("## Rules", ""),
			notes: "# Session notes\n",
		});
		const prompt = buildCheckpointRepairPrompt(issues, {
			checkpoint: "/tmp/checkpoint.md",
			memory: "/tmp/MEMORY.md",
			notes: "/tmp/notes.md",
		});
		expect(issues.length).toBeGreaterThan(0);
		expect(prompt).toContain("CHECKPOINT_PATH = /tmp/checkpoint.md");
		expect(prompt).toContain("MEMORY_PATH = /tmp/MEMORY.md");
		expect(prompt).toContain("Read the files you just wrote");
	});

	it("matches MiMo semantic checks without rejecting the empty template", () => {
		const filler = validCheckpoint.replace(
			"## §2 Next concrete action\n(none yet)",
			"## §2 Next concrete action\ncontinue",
		);
		const discovered = validCheckpoint.replace(
			"(none yet)\n\n## §8 Errors and fixes",
			"- Cache boundary\n  Why: preserve the stable prefix.\n  How to apply: mark the durable boundary.\n- Cache boundary\n  Why: duplicate fact.\n\n## §8 Errors and fixes",
		);
		const fillerIssues = validateCheckpointDocument(filler);
		expect(fillerIssues).toEqual(
			expect.arrayContaining([expect.objectContaining({ rule: "next-filler", severity: "warn" })]),
		);
		const discoveredIssues = validateCheckpointDocument(discovered);
		expect(discoveredIssues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "discovered-duplicate-title", severity: "error" }),
				expect.objectContaining({ rule: "discovered-missing-how-to-apply", severity: "warn" }),
			]),
		);
	});

	it("reports section budgets as extraction-required instead of a generic size failure", () => {
		const oversized = validCheckpoint.replace(
			"## §1 Active intent\n(none yet)",
			`## §1 Active intent\n${"x ".repeat(1500)}`,
		);
		const issues = validateCheckpointDocument(oversized);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "section-budget-exceeded", severity: "extract-required" }),
			]),
		);
	});

	it("validates task progress independently from the checkpoint artifact", () => {
		const issues = validateTaskProgressDocument("# Task progress\n\n- Next: keep going\n", "tasks/demo/progress.md");
		expect(issues).toEqual([
			expect.objectContaining({ rule: "next-filler", severity: "warn", file: "tasks/demo/progress.md" }),
		]);
	});

	it("validates directive revision, live-resource JSON, prior-title reuse, and total budgets", () => {
		const malformed = validCheckpoint.replace(
			"## §9 Live resources\n(none yet)",
			'## §9 Live resources\nMETA: {"pid":',
		);
		const issues = validateCheckpointArtifacts({
			checkpoint: malformed,
			memory: validMemory,
			notes: "# Session notes\n",
			expectedDirectives: [{ id: "D1", expectedText: "keep the API stable" }],
		});
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rule: "meta-malformed-json", severity: "error" }),
				expect.objectContaining({ rule: "directive-not-revised", severity: "error" }),
			]),
		);

		const discovered = validCheckpoint.replace(
			"(none yet)\n\n## §8 Errors and fixes",
			"- Stable API\n  Why: callers depend on it.\n  How to apply: preserve the signature.\n\n## §8 Errors and fixes",
		);
		const prior = validateCheckpointArtifacts({
			checkpoint: discovered,
			memory: validMemory,
			notes: "# Session notes\n",
			priorDiscoveredTitles: new Set(["Stable API"]),
			priorCheckpoint: discovered,
		});
		expect(prior.some((issue) => issue.rule === "discovered-duplicate-title")).toBe(false);

		const oversizedMemory = validMemory.replace("(none yet)", "x ".repeat(25_000));
		expect(validateMemoryDocument(oversizedMemory).map((issue) => issue.rule)).toContain("budget-exceeded");
	});
});
