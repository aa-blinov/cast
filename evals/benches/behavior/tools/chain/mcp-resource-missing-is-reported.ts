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
		containsNone: ["FAQ-INV-5520", "within 21 days"],
		noErrors: true,
	},
};
