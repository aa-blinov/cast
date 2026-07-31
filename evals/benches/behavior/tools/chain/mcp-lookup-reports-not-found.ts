import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const MCP_FIXTURE_SERVER = join(import.meta.dirname, "../../../../fixtures/mcp-release-server.mjs");

export const mcpLookupReportsNotFound: EvalCase = {
	id: "mcp-lookup-reports-not-found",
	description: "An MCP lookup for an unknown component surfaces the tool's error instead of fabricating a release.",
	signals: ["mcp-discovery", "tool-error-recovery", "tool-result-integrity"],
	mcpServers: { release: { command: "node", args: [MCP_FIXTURE_SERVER] } },
	prompt: "Look up the widget-tracker component in the release catalog, then tell me its current published version and status.",
	expect: {
		toolsCalled: ["mcp_release_locate_component"],
		// The fixture server only recognizes "cast" — locate_component returns
		// isError for anything else, and there's no component id to chain into
		// read_release with.
		toolsNotCalled: ["mcp_release_read_release"],
		containsNone: ["0.12.5"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const locate = toolCalls.find((call) => call.name === "mcp_release_locate_component");
			return locate?.result?.isError === true
				? undefined
				: "the not-found MCP result was not observed as an error before the agent answered";
		},
	},
};
