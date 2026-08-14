export type CheckpointValidationRule =
	| "missing-document"
	| "wrong-header"
	| "missing-section"
	| "duplicate-section"
	| "section-out-of-order"
	| "document-too-large"
	| "discovered-duplicate-title"
	| "discovered-missing-why"
	| "discovered-missing-how-to-apply"
	| "next-filler"
	| "directive-not-revised"
	| "meta-malformed-json"
	| "budget-exceeded"
	| "section-budget-exceeded";

export interface CheckpointValidationIssue {
	file: string;
	rule: CheckpointValidationRule;
	severity: "warn" | "error" | "extract-required";
	detail: string;
}

export interface CheckpointArtifactPaths {
	checkpoint: string;
	memory: string;
	notes: string;
}

export const MAX_CHECKPOINT_CHARS = 40_000;
export const MAX_MEMORY_CHARS = 40_000;
export const MAX_NOTES_CHARS = 40_000;
export const MAX_CHECKPOINT_TOKENS = 20_000;
export const MAX_MEMORY_TOKENS = 12_000;

const CHECKPOINT_SECTIONS = [
	"§1 Active intent",
	"§2 Next concrete action",
	"§3 Directives (this session)",
	"§4 Task tree",
	"§5 Current work",
	"§6 Files and code sections",
	"§7 Discovered knowledge (cross-task)",
	"§8 Errors and fixes",
	"§9 Live resources",
	"§10 Design decisions and discussion outcomes",
	"§11 Open notes",
] as const;

const MEMORY_SECTIONS = ["Project context", "Rules", "Architecture decisions", "Discovered durable knowledge"] as const;

const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
	"§1 Active intent": 500,
	"§2 Next concrete action": 1_000,
	"§3 Directives (this session)": 800,
	"§4 Task tree": 1_000,
	"§5 Current work": 2_000,
	"§6 Files and code sections": 1_500,
	"§7 Discovered knowledge (cross-task)": 2_000,
	"§8 Errors and fixes": 1_500,
	"§9 Live resources": 1_000,
	"§10 Design decisions and discussion outcomes": 3_000,
	"§11 Open notes": 800,
};
const MEMORY_SECTION_BUDGETS: Record<string, number> = {
	"Project context": 1_000,
	Rules: 2_000,
	"Architecture decisions": 3_000,
	"Discovered durable knowledge": 4_000,
};

const NEXT_FILLER_RE = /^(continue|resume|keep going|finish up)$/i;
const NEXT_BODY_INSTRUCTIONS_RE = /^\s*_[^\n]*_\s*/m;
const NEXT_BULLET_RE = /^[-*]\s+/;
const NEXT_PROGRESS_RE = /^\s*-?\s*Next:\s*(.+)$/gim;
const NEXT_PROGRESS_PREFIX_RE = /^\s*-?\s*Next:\s*/i;
const SECTION_HEADING_RE = /^##\s+.+?\s*$/m;
const WHY_RE = /^\s*Why:/m;
const HOW_TO_APPLY_RE = /^\s*How to apply:/m;

function sectionHeadings(content: string): Array<{ name: string; index: number }> {
	return [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => ({
		name: match[1]!.trim(),
		index: match.index ?? 0,
	}));
}

function sectionBody(content: string, section: string): string {
	const heading = sectionHeadings(content).find((candidate) => candidate.name === section);
	if (!heading) return "";
	const lineEnd = content.indexOf("\n", heading.index);
	const start = lineEnd < 0 ? content.length : lineEnd + 1;
	const next = content.slice(start).search(SECTION_HEADING_RE);
	return content.slice(start, next < 0 ? content.length : start + next);
}

function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

export function extractDiscoveredTitles(content: string): string[] {
	const discoveredBody = sectionBody(content, "§7 Discovered knowledge (cross-task)");
	return discoveredBody
		.split("\n")
		.filter((line) => NEXT_BULLET_RE.test(line))
		.map((line) => line.replace(NEXT_BULLET_RE, "").trim())
		.filter(Boolean);
}

function extractDiscoveredEntries(content: string): Array<{ title: string; block: string }> {
	const body = sectionBody(content, "§7 Discovered knowledge (cross-task)");
	const entries: Array<{ title: string; block: string }> = [];
	let current: { title: string; lines: string[] } | undefined;
	for (const line of body.split("\n")) {
		if (NEXT_BULLET_RE.test(line)) {
			if (current) entries.push({ title: current.title, block: current.lines.join("\n") });
			current = { title: line.replace(NEXT_BULLET_RE, "").trim(), lines: [line] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) entries.push({ title: current.title, block: current.lines.join("\n") });
	return entries;
}

function semanticCheckpointIssues(
	content: string,
	file: string,
	priorDiscoveredTitles: ReadonlySet<string> = new Set(),
	priorCheckpoint = "",
	expectedDirectives: ReadonlyArray<{ id: string; expectedText: string }> = [],
): CheckpointValidationIssue[] {
	const issues: CheckpointValidationIssue[] = [];
	const nextBody = sectionBody(content, "§2 Next concrete action").replace(NEXT_BODY_INSTRUCTIONS_RE, "").trim();
	if (nextBody && nextBody !== "(none yet)" && NEXT_FILLER_RE.test(nextBody.replace(NEXT_BULLET_RE, "").trim())) {
		issues.push({
			file,
			rule: "next-filler",
			severity: "warn",
			detail: `The next action "${nextBody}" is filler. Replace it with a concrete action, file, function, or command.`,
		});
	}

	const entries = extractDiscoveredEntries(content);
	const titles = new Set<string>();
	const priorEntries = extractDiscoveredEntries(priorCheckpoint);
	for (const entry of entries) {
		const priorEntry = priorEntries.find((candidate) => candidate.title === entry.title);
		if (titles.has(entry.title) || (priorDiscoveredTitles.has(entry.title) && priorEntry?.block !== entry.block)) {
			issues.push({
				file,
				rule: "discovered-duplicate-title",
				severity: "error",
				detail: `Discovered title "${entry.title}" duplicates an entry already present in this or a prior checkpoint. Merge or rephrase it.`,
			});
		}
		titles.add(entry.title);
		if (!WHY_RE.test(entry.block)) {
			issues.push({
				file,
				rule: "discovered-missing-why",
				severity: "warn",
				detail: `Discovered entry "${entry.title}" is missing a "Why:" line.`,
			});
		}
		if (!HOW_TO_APPLY_RE.test(entry.block)) {
			issues.push({
				file,
				rule: "discovered-missing-how-to-apply",
				severity: "warn",
				detail: `Discovered entry "${entry.title}" is missing a "How to apply:" line.`,
			});
		}
	}
	for (const directive of expectedDirectives) {
		if (content.includes(directive.expectedText)) continue;
		issues.push({
			file,
			rule: "directive-not-revised",
			severity: "error",
			detail: `Directive ${directive.id} should mention "${directive.expectedText}" after the latest user instruction.`,
		});
	}

	const liveResources = sectionBody(content, "§9 Live resources");
	for (const match of liveResources.matchAll(/^\s*(?:META|metadata)\s*:\s*(.+?)\s*$/gim)) {
		try {
			JSON.parse(match[1]!);
		} catch {
			issues.push({
				file,
				rule: "meta-malformed-json",
				severity: "error",
				detail: `Live-resource metadata is not valid JSON: ${match[1]}`,
			});
		}
	}

	return issues.concat(sectionBudgetIssues(content, file, CHECKPOINT_SECTION_BUDGETS));
}

function sectionBudgetIssues(
	content: string,
	file: string,
	budgets: Record<string, number>,
): CheckpointValidationIssue[] {
	const issues: CheckpointValidationIssue[] = [];
	for (const [section, budget] of Object.entries(budgets)) {
		const body = sectionBody(content, section);
		if (estimateTokens(body) <= budget) continue;
		issues.push({
			file,
			rule: "section-budget-exceeded",
			severity: "extract-required",
			detail: `Section "${section}" is approximately ${estimateTokens(body)} tokens; the budget is ${budget}. Extract lower-priority material into a spillover file.`,
		});
	}
	return issues;
}

function validateStructuredDocument(
	content: string,
	file: string,
	header: string,
	sections: readonly string[],
	maxChars: number,
): CheckpointValidationIssue[] {
	const issues: CheckpointValidationIssue[] = [];
	if (!content.trim()) {
		return [
			{
				file,
				rule: "missing-document",
				severity: "error",
				detail: "The writer did not produce a readable document.",
			},
		];
	}
	if (content.length > maxChars) {
		issues.push({
			file,
			rule: "document-too-large",
			severity: "error",
			detail: `The document is ${content.length} characters; the limit is ${maxChars}.`,
		});
	}
	const firstNonEmpty = content
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim();
	if (firstNonEmpty !== header) {
		issues.push({
			file,
			rule: "wrong-header",
			severity: "error",
			detail: `The first non-empty line must be exactly "${header}".`,
		});
	}
	const headings = sectionHeadings(content);
	for (const section of sections) {
		if (headings.filter((heading) => heading.name === section).length === 0) {
			issues.push({
				file,
				rule: "missing-section",
				severity: "error",
				detail: `Missing required section "## ${section}".`,
			});
		}
	}
	for (const section of sections) {
		if (headings.filter((heading) => heading.name === section).length > 1) {
			issues.push({
				file,
				rule: "duplicate-section",
				severity: "error",
				detail: `Section "## ${section}" appears more than once.`,
			});
		}
	}
	const expected = sections.map((section) => headings.find((heading) => heading.name === section)?.index ?? -1);
	if (
		expected.some(
			(index, position) =>
				index >= 0 && expected.slice(0, position).some((previous) => previous >= 0 && previous > index),
		)
	) {
		issues.push({
			file,
			rule: "section-out-of-order",
			severity: "error",
			detail: `Required sections must appear in this order: ${sections.join(", ")}.`,
		});
	}
	return issues;
}

export function validateCheckpointDocument(content: string, file = "checkpoint.md"): CheckpointValidationIssue[] {
	return validateCheckpointDocumentWithOptions(content, file);
}

function validateCheckpointDocumentWithOptions(
	content: string,
	file: string,
	options: {
		priorDiscoveredTitles?: ReadonlySet<string>;
		priorCheckpoint?: string;
		expectedDirectives?: ReadonlyArray<{ id: string; expectedText: string }>;
	} = {},
): CheckpointValidationIssue[] {
	const structural = validateStructuredDocument(
		content,
		file,
		"# Session checkpoint",
		CHECKPOINT_SECTIONS,
		MAX_CHECKPOINT_CHARS,
	);
	return content.trim() && structural.every((issue) => issue.rule !== "missing-document")
		? [
				...structural,
				...semanticCheckpointIssues(
					content,
					file,
					options.priorDiscoveredTitles,
					options.priorCheckpoint,
					options.expectedDirectives,
				),
				...validateBudget(content, MAX_CHECKPOINT_TOKENS, file),
			]
		: structural;
}

export function validateMemoryDocument(content: string, file = "MEMORY.md"): CheckpointValidationIssue[] {
	const structural = validateStructuredDocument(content, file, "# Project memory", MEMORY_SECTIONS, MAX_MEMORY_CHARS);
	return content.trim() && structural.every((issue) => issue.rule !== "missing-document")
		? [
				...structural,
				...sectionBudgetIssues(content, file, MEMORY_SECTION_BUDGETS),
				...validateBudget(content, MAX_MEMORY_TOKENS, file),
			]
		: structural;
}

function validateBudget(content: string, budget: number, file: string): CheckpointValidationIssue[] {
	const tokens = estimateTokens(content);
	return tokens <= budget
		? []
		: [
				{
					file,
					rule: "budget-exceeded",
					severity: "extract-required",
					detail: `The document is approximately ${tokens} tokens; the budget is ${budget}. Extract lower-priority material into a spillover file.`,
				},
			];
}

export function validateNotesDocument(content: string, file = "notes.md"): CheckpointValidationIssue[] {
	if (
		content.length <= MAX_NOTES_CHARS &&
		(content.trim() === "" || content.trimStart().startsWith("# Session notes"))
	)
		return [];
	return [
		{
			file,
			rule: content.length > MAX_NOTES_CHARS ? "document-too-large" : "wrong-header",
			severity: "error",
			detail:
				content.length > MAX_NOTES_CHARS
					? `The document is ${content.length} characters; the limit is ${MAX_NOTES_CHARS}.`
					: 'The first non-empty line must be exactly "# Session notes".',
		},
	];
}

export function validateTaskProgressDocument(content: string, file: string): CheckpointValidationIssue[] {
	if (!content.trim()) return [];
	const matches = content.match(NEXT_PROGRESS_RE) ?? [];
	return matches.flatMap((line) => {
		const value = line.replace(NEXT_PROGRESS_PREFIX_RE, "").trim();
		return NEXT_FILLER_RE.test(value)
			? [
					{
						file,
						rule: "next-filler" as const,
						severity: "warn" as const,
						detail: `"Next: ${value}" is filler. Replace it with a concrete action.`,
					},
				]
			: [];
	});
}

export function hasBlockingCheckpointIssues(issues: CheckpointValidationIssue[]): boolean {
	return issues.some((issue) => issue.severity !== "warn");
}

export function validateCheckpointArtifacts(input: {
	checkpoint: string;
	memory: string;
	notes: string;
	taskProgress?: Record<string, string>;
	priorDiscoveredTitles?: ReadonlySet<string>;
	priorCheckpoint?: string;
	expectedDirectives?: ReadonlyArray<{ id: string; expectedText: string }>;
}): CheckpointValidationIssue[] {
	return [
		...validateCheckpointDocumentWithOptions(input.checkpoint, "checkpoint.md", input),
		...validateMemoryDocument(input.memory),
		...validateNotesDocument(input.notes),
		...Object.entries(input.taskProgress ?? {}).flatMap(([file, content]) =>
			validateTaskProgressDocument(content, file),
		),
	];
}

export function buildCheckpointRepairPrompt(
	issues: CheckpointValidationIssue[],
	paths: CheckpointArtifactPaths,
): string {
	const grouped = new Map<string, string[]>();
	for (const issue of issues) {
		const entries = grouped.get(issue.file) ?? [];
		entries.push(`- ${issue.detail}`);
		grouped.set(issue.file, entries);
	}
	const report = [...grouped.entries()].map(([file, entries]) => `${file}:\n${entries.join("\n")}`).join("\n\n");
	return [
		"<system-reminder>",
		"The previous checkpoint write failed validation. Read the files you just wrote, fix only the listed issues, and write them again.",
		"Warnings are advisory; fix every error and extraction-required issue before stopping.",
		"For extraction-required issues, move lower-priority material into a topic-named spillover file and leave a short index line in the main file.",
		"Do not modify source code or create alternate memory files outside the named spillover files.",
		"",
		report,
		"",
		`CHECKPOINT_PATH = ${paths.checkpoint}`,
		`MEMORY_PATH = ${paths.memory}`,
		`NOTES_PATH = ${paths.notes}`,
		"</system-reminder>",
	].join("\n");
}
