import type { EvalCase } from "../../../../lib/runner.ts";

export const btwAnswersFromContext: EvalCase = {
	id: "btw-answers-from-context",
	description:
		"A /btw question is answered from what the conversation holds, and neither it nor the answer joins the conversation.",
	signals: ["btw", "context-recall"],
	prompt: "For the record: the staging database host is db-staging-17. Reply with just OK.",
	sideQuestion: { question: "What is the staging database host? Answer in one short sentence.", when: "after" },
	expect: {
		noErrors: true,
		verify: ({ sideAnswer, messages }) => {
			if (sideAnswer?.error) return `the side question failed: ${sideAnswer.error}`;
			if (!sideAnswer?.text?.includes("db-staging-17"))
				return `the answer did not recall the host: ${JSON.stringify(sideAnswer?.text)}`;
			const kept = JSON.stringify(messages);
			if (kept.includes("What is the staging database host?"))
				return "the side question ended up in the conversation";
			if (kept.includes("side question")) return "the side-question framing ended up in the conversation";
			return messages.filter((m) => m.role === "user").length === 1
				? undefined
				: "the conversation gained a user message";
		},
	},
};
