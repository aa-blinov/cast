import { join } from "node:path";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const MCP_FIXTURE_SERVER = join(import.meta.dirname, "../../../../fixtures/mcp-release-server.mjs");

export const mcpReleaseLookupChain: EvalCase = {
	id: "mcp-release-lookup-chain",
	description: "The agent chains two connected MCP lookups to answer a user-facing release question.",
	signals: ["mcp-discovery", "mcp-tool-chain", "tool-result-integrity"],
	mcpServers: { release: { command: "node", args: [MCP_FIXTURE_SERVER] } },
	prompt: "Look up the cast component in the release catalog, then tell me its current published version and status.",
	expect: {
		toolSubsequence: ["mcp_release_locate_component", "mcp_release_read_release"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const locate = toolCalls.find((item) => item.name === "mcp_release_locate_component");
			const release = toolCalls.find((item) => item.name === "mcp_release_read_release");
			return locate?.args.component === "cast" &&
				release?.args.component_id === "cast-core" &&
				release.result?.content.includes("готово к публикации")
				? undefined
				: "MCP lookup chain did not pass the component id or preserve the release result";
		},
	},
};
