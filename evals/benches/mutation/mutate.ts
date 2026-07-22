/**
 * Auto-generated edit-precision tasks — ported from oh-my-pi's
 * typescript-edit-benchmark (github.com/can1357/oh-my-pi, packages/typescript-edit-benchmark):
 * take a real source file, inject ONE small mechanical bug via AST mutation,
 * describe the bug category in plain English (not the exact fix — the model
 * has to find and apply it precisely), and grade by comparing the agent's
 * output against the original file.
 *
 * Deliberately narrower than the original (3 mutation kinds vs their ~6,
 * syntactic token splices instead of full AST regeneration) — this tests
 * edit *precision*, not bug-finding, so a handful of well-understood mutation
 * shapes covers the interesting harness behavior without pulling in a new
 * parser dependency. Uses the TypeScript compiler API (already a devDependency
 * for tsc) instead of oh-my-pi's Babel — no new deps.
 */

import * as ts from "typescript";

export interface MutationInfo {
	category: string;
	/** 1-indexed line the mutation landed on. */
	lineNumber: number;
	originalLine: string;
	mutatedLine: string;
	/** Plain-English bug description — names the category and location, not the fix. */
	describe(): string;
}

export interface Mutation {
	mutatedSource: string;
	info: MutationInfo;
}

interface Candidate {
	start: number;
	end: number;
	replacement: string;
	category: string;
}

/** Deterministic PRNG (mulberry32) — same seed always produces the same mutation pick. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const COMPARISON_SWAPS: Partial<Record<ts.SyntaxKind, [ts.SyntaxKind, string]>> = {
	[ts.SyntaxKind.EqualsEqualsEqualsToken]: [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!=="],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken]: [ts.SyntaxKind.EqualsEqualsEqualsToken, "==="],
	[ts.SyntaxKind.LessThanToken]: [ts.SyntaxKind.LessThanEqualsToken, "<="],
	[ts.SyntaxKind.LessThanEqualsToken]: [ts.SyntaxKind.LessThanToken, "<"],
	[ts.SyntaxKind.GreaterThanToken]: [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
	[ts.SyntaxKind.GreaterThanEqualsToken]: [ts.SyntaxKind.GreaterThanToken, ">"],
	[ts.SyntaxKind.AmpersandAmpersandToken]: [ts.SyntaxKind.BarBarToken, "||"],
	[ts.SyntaxKind.BarBarToken]: [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
};

function findCandidates(sourceFile: ts.SourceFile): Candidate[] {
	const candidates: Candidate[] = [];

	function visit(node: ts.Node): void {
		if (ts.isBinaryExpression(node)) {
			const swap = COMPARISON_SWAPS[node.operatorToken.kind];
			if (swap) {
				candidates.push({
					start: node.operatorToken.getStart(sourceFile),
					end: node.operatorToken.getEnd(),
					replacement: swap[1],
					category: "comparison-operator-swap",
				});
			}
		} else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
			candidates.push({
				start: node.getStart(sourceFile),
				end: node.getEnd(),
				replacement: node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true",
				category: "boolean-flip",
			});
		} else if (ts.isNumericLiteral(node)) {
			const value = Number(node.text);
			// Skip 0/1 (usually indices/booleans-as-numbers, easy to accidentally
			// break unrelated code like array bounds) and anything non-integer or
			// implausibly large (version numbers, byte sizes — a ±1 there reads as
			// noise, not a "bug").
			if (Number.isInteger(value) && value > 1 && value < 1000) {
				candidates.push({
					start: node.getStart(sourceFile),
					end: node.getEnd(),
					replacement: String(value + (value % 2 === 0 ? 1 : -1)),
					category: "off-by-one",
				});
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates;
}

/**
 * Pick one mutation site in `source` (a .ts file's content) and apply it as a
 * plain string splice — not a full AST regeneration — so every byte outside
 * the mutated token is untouched, same as oh-my-pi's approach.
 */
export function mutateOne(source: string, fileName: string, seed: number): Mutation | undefined {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const candidates = findCandidates(sourceFile);
	if (candidates.length === 0) return undefined;

	const rng = mulberry32(seed);
	const pick = candidates[Math.floor(rng() * candidates.length)]!;

	const mutatedSource = source.slice(0, pick.start) + pick.replacement + source.slice(pick.end);
	const { line } = sourceFile.getLineAndCharacterOfPosition(pick.start);
	const originalLine = source.split("\n")[line] ?? "";
	const mutatedLine = mutatedSource.split("\n")[line] ?? "";

	const descriptions: Record<string, string> = {
		"comparison-operator-swap": `A comparison or logical operator on line ${line + 1} was flipped, inverting the condition's logic.`,
		"boolean-flip": `A boolean literal on line ${line + 1} was flipped to its opposite value.`,
		"off-by-one": `A numeric literal on line ${line + 1} is off by one from its correct value.`,
	};

	return {
		mutatedSource,
		info: {
			category: pick.category,
			lineNumber: line + 1,
			originalLine,
			mutatedLine,
			describe: () => descriptions[pick.category] ?? `A mutation was introduced on line ${line + 1}.`,
		},
	};
}
