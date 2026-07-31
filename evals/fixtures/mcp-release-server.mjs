#!/usr/bin/env node
// Small real MCP server used by the behavior bench. It runs over stdio so the
// eval exercises the same local-server handshake as a user's .cast/mcp.json.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "cast-release-fixture", version: "1.0.0" });

server.registerTool(
	"locate_component",
	{
		description: "Finds the stable catalog identifier for a named component. Use this before reading release details.",
		inputSchema: { component: z.string() },
	},
	async ({ component }) => {
		if (component !== "cast") {
			return {
				content: [{ type: "text", text: `no catalog entry for component "${component}"` }],
				isError: true,
			};
		}
		return { content: [{ type: "text", text: `${component} -> component_id=cast-core` }] };
	},
);

server.registerTool(
	"read_release",
	{
		description: "Reads the published release status and version for a catalog component id.",
		inputSchema: { component_id: z.string() },
	},
	async ({ component_id }) => {
		if (component_id !== "cast-core") {
			return {
				content: [{ type: "text", text: `no release record for component_id "${component_id}"` }],
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `${component_id}: готово к публикации, версия 0.12.5 🚀`,
				},
			],
		};
	},
);

await server.connect(new StdioServerTransport());
