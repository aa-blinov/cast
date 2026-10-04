import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const SKILLS = join(import.meta.dirname, "../../../../fixtures/skills");

export const skillArgumentsReachTheBody: EvalCase = {
	id: "skill-arguments-reach-the-body",
	description:
		"The agent passes the ticket number as the skill's argument, and the skill's body comes back with it filled in.",
	signals: ["skill-discovery", "tool-result-integrity"],
	withSkills: true,
	skillPaths: [join(SKILLS, "ticket-summary")],
	prompt: "Use the ticket summary skill for ticket 4821.",
	expect: {
		toolsCalled: ["skill"],
		containsAll: ["TICKET-REF-4821"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const call = toolCalls.find((c) => c.name === "skill");
			return String(call?.args.args ?? "").includes("4821")
				? undefined
				: `the skill was called with args ${JSON.stringify(call?.args.args)}`;
		},
	},
};
