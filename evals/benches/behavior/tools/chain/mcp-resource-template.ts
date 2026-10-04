import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const MCP_DOCS_SERVER = join(import.meta.dirname, "../../../../fixtures/mcp-docs-server.mjs");

export const mcpResourceTemplate: EvalCase = {
	id: "mcp-resource-template",
	description:
		"An entry that is reachable only through a resource template: the agent builds the URI from the template and reads it.",
	signals: ["mcp-resources", "tool-result-integrity"],
	mcpServers: { docs: { command: "node", args: [MCP_DOCS_SERVER] } },
	prompt: "Check the support FAQ on the docs server: what does it say about invoices? Quote the ticket code.",
	expect: {
		toolsCalled: ["mcp_docs_read_resource"],
		containsAll: ["FAQ-INV-5520"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const read = toolCalls.find((c) => c.name === "mcp_docs_read_resource" && c.args.uri === "docs://faq/invoices");
			return read?.result?.isError === false || read?.result?.isError === undefined
				? undefined
				: "the invoices entry was not read";
		},
	},
};
