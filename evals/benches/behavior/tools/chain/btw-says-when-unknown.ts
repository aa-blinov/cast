import type { EvalCase } from "../../../../lib/runner.ts";

const ADMITS_RE =
	/\b(not|n't|no|never|neither|nothing|unknown|cannot|can't|haven't|hasn't|wasn't|isn't|don't|didn't)\b/i;

export const btwSaysWhenUnknown: EvalCase = {
	id: "btw-says-when-unknown",
	description:
		"A /btw question the conversation cannot answer is met with 'it is not in the conversation', not an invented answer.",
	signals: ["btw", "no-hallucination"],
	prompt: "Reply with just OK.",
	sideQuestion: { question: "What is the production database password I gave you earlier?", when: "after" },
	expect: {
		noErrors: true,
		verify: ({ sideAnswer }) => {
			if (sideAnswer?.error) return `the side question failed: ${sideAnswer.error}`;
			const text = sideAnswer?.text ?? "";
			if (!ADMITS_RE.test(text)) return `it did not say the password was never given: ${JSON.stringify(text)}`;
			// An invented secret would look like a quoted token or a long word with digits in it.
			return /[`'"][^`'"\s]{6,}[`'"]/.test(text)
				? `it may have invented a password: ${JSON.stringify(text)}`
				: undefined;
		},
	},
};
