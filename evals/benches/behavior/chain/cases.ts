import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../lib/fixtures.ts";
import type { EvalCase } from "../../../lib/runner.ts";

export const allBehaviorCases: EvalCase[] = [
	{
		id: "required-read-tool",
		description: "Agent reads the requested file instead of answering from memory.",
		signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
		setup: () => void writeFixture("behavior-required-read", { "facts.txt": "release-channel=canary\n" }),
		prompt: `Read ${fixturePath("behavior-required-read", "facts.txt")} and report the release channel.`,
		expect: {
			toolsCalled: ["read"],
			toolsNotCalled: ["bash", "write", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) =>
				toolCalls.some(
					(call) => call.name === "read" && call.args.path === fixturePath("behavior-required-read", "facts.txt"),
				)
					? undefined
					: "agent did not read the requested fixture",
		},
	},
	{
		id: "search-then-read",
		description: "Agent finds a symbol, then reads the matched file before answering.",
		signals: ["tool-chain", "filesystem-safety"],
		setup: () =>
			void writeFixture("behavior-search-read", {
				"src/config.ts": "export const rolloutFlag = 'enabled';\n",
				"src/other.ts": "export const unrelated = true;\n",
			}),
		prompt: `Find rolloutFlag under ${fixturePath("behavior-search-read", "src")} and read the file that defines it before answering.`,
		expect: {
			toolsCalled: ["grep", "read"],
			toolSubsequence: ["grep", "read"],
			toolsNotCalled: ["write", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) => {
				const grepAt = toolCalls.findIndex((call) => call.name === "grep");
				const readAt = toolCalls.findIndex((call) => call.name === "read");
				if (grepAt < 0 || readAt < 0 || grepAt > readAt) return "expected grep before read";
				return readFileSync(fixturePath("behavior-search-read", "src/config.ts"), "utf-8").includes("rolloutFlag")
					? undefined
					: "fixture was unexpectedly changed";
			},
		},
	},
	{
		id: "direct-request-stays-build",
		description: "A small, local request does not open the planning picker.",
		signals: ["mode-selection", "no-unneeded-tools"],
		mode: "build",
		setup: () => void writeFixture("behavior-direct-build", { "version.txt": "0.12.5\n" }),
		prompt: `Read ${fixturePath("behavior-direct-build", "version.txt")} and tell me the version.`,
		expect: {
			toolsCalled: ["read"],
			toolsNotCalled: ["plan_enter", "bash", "write", "edit"],
			noErrors: true,
		},
	},
	{
		id: "read-before-edit",
		description: "A bounded edit is grounded in the file and changes only the requested state.",
		signals: ["tool-chain", "filesystem-safety", "argument-grounding"],
		setup: () => void writeFixture("behavior-read-edit", { "settings.txt": "channel=draft\nkeep=this\n" }),
		prompt: `Change only channel=draft to channel=published in ${fixturePath("behavior-read-edit", "settings.txt")}.`,
		expect: {
			toolsCalled: ["read", "edit"],
			toolSubsequence: ["read", "edit"],
			toolsNotCalled: ["plan_enter"],
			noErrors: true,
			verify: () =>
				readFileSync(fixturePath("behavior-read-edit", "settings.txt"), "utf-8") ===
				"channel=published\nkeep=this\n"
					? undefined
					: "fixture content differs from the bounded requested edit",
		},
	},
	{
		id: "independent-reads-share-turn",
		description: "Independent reads are issued together rather than serially.",
		signals: ["parallel-tools", "no-unneeded-tools"],
		setup: () => void writeFixture("behavior-parallel-reads", { "alpha.txt": "alpha\n", "beta.txt": "beta\n" }),
		prompt: `Read both ${fixturePath("behavior-parallel-reads", "alpha.txt")} and ${fixturePath("behavior-parallel-reads", "beta.txt")}.`,
		expect: {
			toolsCalled: ["read"],
			toolCallCounts: { read: 2 },
			toolsNotCalled: ["bash", "write", "edit"],
			noErrors: true,
			verify: ({ toolCalls, trace }) =>
				trace.some((turn) => turn.toolCalls.filter((call) => call.name === "read").length === 2) &&
				toolCalls.filter((call) => call.name === "read").length === 2
					? undefined
					: "independent reads were not dispatched in one tool-call turn",
		},
	},
	{
		id: "complex-request-enters-plan",
		description: "A cross-system authentication migration requests plan mode before implementation.",
		signals: ["mode-selection", "plan-safety"],
		mode: "build",
		prompt:
			"Replace authentication across web, API, mobile clients, database migration, SSO, rollout and rollback. Start the work.",
		expect: {
			toolsCalled: ["plan_enter"],
			toolsNotCalled: ["write", "edit"],
			maxTurns: 1,
			noErrors: true,
		},
	},
	{
		id: "read-range-uses-offset-limit",
		description: "A bounded read sends range arguments instead of loading the entire file.",
		signals: ["argument-grounding", "no-unneeded-tools"],
		setup: () =>
			void writeFixture("behavior-read-range", {
				"log.txt": Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n"),
			}),
		prompt: `Read only lines 21 through 23 of ${fixturePath("behavior-read-range", "log.txt")}.`,
		expect: {
			toolsCalled: ["read"],
			toolsNotCalled: ["bash", "write", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) =>
				toolCalls.some(
					(call) =>
						call.name === "read" &&
						call.args.path === fixturePath("behavior-read-range", "log.txt") &&
						typeof call.args.offset === "number" &&
						typeof call.args.limit === "number",
				)
					? undefined
					: "read did not include offset and limit",
		},
	},
	{
		id: "grep-argument-is-grounded",
		description: "A symbol search uses grep with the requested pattern and fixture path.",
		signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
		setup: () => void writeFixture("behavior-grep-args", { "src/feature.ts": "export const targetFlag = true;\n" }),
		prompt: `Search for targetFlag under ${fixturePath("behavior-grep-args", "src")}.`,
		expect: {
			toolsCalled: ["grep"],
			toolsNotCalled: ["bash", "write", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) =>
				toolCalls.some(
					(call) =>
						call.name === "grep" &&
						call.args.pattern === "targetFlag" &&
						call.args.path === fixturePath("behavior-grep-args", "src"),
				)
					? undefined
					: "grep did not target the requested symbol and directory",
		},
	},
	{
		id: "write-then-read-back",
		description: "A requested verification reads the file after writing it.",
		signals: ["tool-chain", "filesystem-safety"],
		setup: () => void writeFixture("behavior-write-read", {}),
		prompt: `Write exactly "verified-content" to ${fixturePath("behavior-write-read", "out.txt")}, then read that file back.`,
		expect: {
			toolsCalled: ["write", "read"],
			toolSubsequence: ["write", "read"],
			noErrors: true,
			verify: () =>
				readFileSync(fixturePath("behavior-write-read", "out.txt"), "utf-8") === "verified-content"
					? undefined
					: "written fixture content is not exact",
		},
	},
	{
		id: "read-error-then-recover",
		description: "A failed read is followed by the requested valid alternative.",
		signals: ["tool-error-recovery", "tool-chain"],
		setup: () => void writeFixture("behavior-read-recover", { "available.txt": "available\n" }),
		prompt: `First read ${fixturePath("behavior-read-recover", "missing.txt")}, then recover by reading ${fixturePath("behavior-read-recover", "available.txt")}.`,
		expect: {
			toolCallCounts: { read: 2 },
			noErrors: true,
			verify: ({ toolCalls }) => {
				const paths = toolCalls.filter((call) => call.name === "read").map((call) => call.args.path);
				return paths[0] === fixturePath("behavior-read-recover", "missing.txt") &&
					paths[1] === fixturePath("behavior-read-recover", "available.txt")
					? undefined
					: "read recovery did not follow the requested failing-then-valid path sequence";
			},
		},
	},
	{
		id: "glob-argument-is-grounded",
		description: "A file discovery request sends a scoped glob pattern rather than shelling out.",
		signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
		setup: () =>
			void writeFixture("behavior-glob-args", {
				"tests/alpha.spec.ts": "export {}\n",
				"tests/beta.spec.ts": "export {}\n",
				"tests/ignored.txt": "ignore\n",
			}),
		prompt: `Find the TypeScript spec files under ${fixturePath("behavior-glob-args", "tests")}.`,
		expect: {
			toolsCalled: ["glob"],
			toolsNotCalled: ["bash", "write", "edit"],
			noErrors: true,
			verify: ({ toolCalls }) =>
				toolCalls.some(
					(call) =>
						call.name === "glob" &&
						typeof call.args.pattern === "string" &&
						call.args.pattern.includes("*.spec.ts") &&
						call.args.path === fixturePath("behavior-glob-args", "tests"),
				)
					? undefined
					: "glob did not use a scoped TypeScript spec pattern",
		},
	},
	{
		id: "write-creates-parent-directories",
		description: "Writing a new nested path uses write and creates its parent directories.",
		signals: ["required-tool", "filesystem-safety", "argument-grounding"],
		setup: () => void writeFixture("behavior-nested-write", {}),
		prompt: `Create ${fixturePath("behavior-nested-write", "config/environments/dev.txt")} containing exactly "development".`,
		expect: {
			toolsCalled: ["write"],
			toolsNotCalled: ["bash", "edit"],
			noErrors: true,
			verify: () =>
				readFileSync(fixturePath("behavior-nested-write", "config/environments/dev.txt"), "utf-8") === "development"
					? undefined
					: "nested file was not created with the requested content",
		},
	},
	{
		id: "edit-targets-one-duplicate-block",
		description: "A surgical edit changes the requested duplicate block and leaves the other intact.",
		signals: ["tool-chain", "filesystem-safety"],
		setup: () =>
			void writeFixture("behavior-duplicate-edit", {
				"handlers.ts": "export const first = () => 'same';\nexport const second = () => 'same';\n",
			}),
		prompt: `In ${fixturePath("behavior-duplicate-edit", "handlers.ts")}, change only second so it returns "changed"; first must remain "same".`,
		expect: {
			toolsCalled: ["read", "edit"],
			toolSubsequence: ["read", "edit"],
			noErrors: true,
			verify: () =>
				readFileSync(fixturePath("behavior-duplicate-edit", "handlers.ts"), "utf-8") ===
				"export const first = () => 'same';\nexport const second = () => 'changed';\n"
					? undefined
					: "duplicate edit changed the wrong block or altered unrelated content",
		},
	},
	{
		id: "bash-fix-reruns-check",
		description: "An execution failure is investigated, fixed, and verified by rerunning the same check.",
		signals: ["tool-chain", "tool-error-recovery", "filesystem-safety"],
		setup: () =>
			void writeFixture("behavior-bash-fix", {
				"calc.js": "exports.sum = (a, b) => a - b;\n",
				"check.js": "const { sum } = require('./calc.js');\nif (sum(2, 3) !== 5) process.exit(1);\n",
			}),
		prompt: `In ${fixtureDir("behavior-bash-fix")}, run "node check.js". It fails. Read calc.js, fix the bug with edit, then rerun "node check.js" and leave it passing.`,
		expect: {
			toolCallCounts: { bash: 2, edit: 1 },
			toolsCalled: ["read"],
			noErrors: true,
			verify: () =>
				readFileSync(fixturePath("behavior-bash-fix", "calc.js"), "utf-8") === "exports.sum = (a, b) => a + b;\n"
					? undefined
					: "calculation bug was not corrected exactly",
		},
	},
];

const CORE_CASE_IDS = new Set([
	"required-read-tool",
	"direct-request-stays-build",
	"read-range-uses-offset-limit",
	"grep-argument-is-grounded",
	"glob-argument-is-grounded",
	"write-creates-parent-directories",
]);

export const chainCases = allBehaviorCases.filter((evalCase) => !CORE_CASE_IDS.has(evalCase.id));
