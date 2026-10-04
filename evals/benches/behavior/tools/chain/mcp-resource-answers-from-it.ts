import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const MCP_DOCS_SERVER = join(import.meta.dirname, "../../../../fixtures/mcp-docs-server.mjs");

export const mcpResourceAnswersFromIt: EvalCase = {
	id: "mcp-resource-answers-from-it",
	description:
		"A docs server that offers resources and no tools: the agent finds the runbook through the resource tools and answers from what it read.",
	signals: ["mcp-resources", "tool-result-integrity"],
	mcpServers: { docs: { command: "node", args: [MCP_DOCS_SERVER] } },
	prompt: "The docs server has our deploy runbook. What is step 4 of it, exactly?",
	expect: {
		toolsCalled: ["mcp_docs_read_resource"],
		containsAll: ["EDGE-PURGE-7431"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const read = toolCalls.find((c) => c.name === "mcp_docs_read_resource");
			return String(read?.args.uri ?? "") === "docs://runbook/deploy"
				? undefined
				: `it read ${JSON.stringify(read?.args.uri)}, not the deploy runbook`;
		},
	},
};
