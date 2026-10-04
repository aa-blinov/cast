#!/usr/bin/env node
// Small real MCP server used by the behavior bench: it offers documents as resources and has no tools at all,
// the way a docs or wiki server does. Over stdio, like a user's .cast/mcp.json entry.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "cast-docs-fixture", version: "1.0.0" });

const RUNBOOK = [
	"# Deploy runbook",
	"1. Freeze merges on main.",
	"2. Tag the release candidate.",
	"3. Run the smoke suite against staging.",
	"4. Purge the edge cache with the token EDGE-PURGE-7431.",
	"5. Announce the release in the channel.",
].join("\n");

server.registerResource(
	"deploy-runbook",
	"docs://runbook/deploy",
	{ title: "Deploy runbook", description: "The steps of a production deploy", mimeType: "text/markdown" },
	async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: RUNBOOK }] }),
);

server.registerResource(
	"rollback-runbook",
	"docs://runbook/rollback",
	{ title: "Rollback runbook", description: "How to undo a deploy", mimeType: "text/markdown" },
	async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Rollback\nRevert the tag, then redeploy the previous image." }] }),
);

const FAQ = { invoices: "Invoices are issued on the 3rd and payable within 21 days (ticket code FAQ-INV-5520).", refunds: "Refunds go back to the original card within 5 days." };

server.registerResource(
	"faq",
	new ResourceTemplate("docs://faq/{topic}", { list: undefined }),
	{ title: "FAQ", description: "A support FAQ entry by topic: invoices, refunds", mimeType: "text/plain" },
	async (uri, { topic }) => {
		const text = FAQ[String(topic)];
		if (!text) throw new Error(`no FAQ entry for "${topic}"`);
		return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
	},
);

await server.connect(new StdioServerTransport());
