import { join } from "node:path";
import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const globArgumentIsGrounded: EvalCase = {
	id: "glob-argument-is-grounded",
	description: "A file discovery request sends a scoped glob pattern rather than shelling out.",
	signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
	setup: () =>
		void writeFixture("behavior-glob-args", {
			"tests/alpha.spec.ts": "export {}\n",
			"tests/beta.spec.ts": "export {}\n",
			"tests/ignored.txt": "ignore\n",
		}),
	prompt: `Which TypeScript spec files are present under ${fixturePath("behavior-glob-args", "tests")}?`,
	expect: {
		containsAll: ["alpha.spec.ts", "beta.spec.ts"],
		containsNone: ["ignored.txt"],
		toolsCalled: ["glob"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		// The contract is a search scoped to the fixture directory and narrowed
		// to TypeScript specs. Grading the argument *shape* instead kept failing
		// calls that answered the question correctly: a brace pattern
		// (`**/*.{spec,test}.ts`), an absolute pattern carrying its own scope,
		// and `path` on the fixture root with `tests/` in the pattern — and
		// `**/*.ts` scoped to tests/, which lists the specs and nothing else here,
		// with the answer (graded above) picking them out. What matters is where
		// the two arguments point once joined, narrowed to TypeScript.
		verify: ({ toolCalls }) => {
			const dir = fixturePath("behavior-glob-args", "tests");
			return toolCalls.some((call) => {
				if (call.name !== "glob" || typeof call.args.pattern !== "string") return false;
				const pattern = call.args.pattern;
				const scope = typeof call.args.path === "string" ? join(call.args.path, pattern) : pattern;
				return scope.startsWith(dir) && pattern.endsWith(".ts");
			})
				? undefined
				: "glob did not use a TypeScript pattern scoped to the tests directory";
		},
	},
};
