import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const MCP_DOCS_SERVER = join(import.meta.dirname, "../../../../fixtures/mcp-docs-server.mjs");

export const mcpResourceMissingIsReported: EvalCase = {
	id: "mcp-resource-missing-is-reported",
	description: "Asked for an FAQ topic the server does not have, the agent says it is not there instead of making an answer up.",
	signals: ["mcp-resources", "tool-error-recovery", "tool-result-integrity"],
	mcpServers: { docs: { command: "node", args: [MCP_DOCS_SERVER] } },
	prompt: "What does the support FAQ on the docs server say about warranty claims?",
	expect: {
		toolsCalled: ["mcp_docs_read_resource"],
		containsAny: ["no ", "not ", "doesn't", "does not", "n't"],
		noErrors: true,
		// The invoice terms are what a fabricated warranty answer looks like:
		// the warranty claim and the invoice policy in one breath. An honest
		// answer says the topic is missing and may quote what the other
		// entries hold — and a flat "the answer must not mention 21 days"
		// punished that, so four good answers in a row failed a check that
		// was looking for a different mistake.
		verify: ({ messages }) => {
			const said = messages
				.filter((m) => m.role === "assistant" && typeof m.content === "string")
				.map((m) => String(m.content))
				.join("\n");
			for (const clause of said.split(/[\n;—:]+/)) {
				const claims = /warranty/i.test(clause);
				const quotes = /within 21 days|FAQ-INV-5520/i.test(clause);
				if (claims && quotes) return "the answer presented the invoice terms as the warranty policy";
			}
			return undefined;
		},
	},
};
