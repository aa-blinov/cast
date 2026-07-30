import { describe, expect, it } from "vitest";
import type { Tool } from "../src/core/llm.ts";
import { formatMcpForPrompt, type McpSetupResult, mcpServerNameFromDescription } from "../src/core/mcp.ts";

function makeResult(
	connections: { serverName: string; toolCount: number }[],
	tools: { name: string; description: string }[],
): McpSetupResult {
	return {
		connections: connections as McpSetupResult["connections"],
		toolDefinitions: tools.map((t) => ({
			type: "function" as const,
			function: { name: t.name, description: t.description, parameters: {} },
		})) as Tool[],
		toolIndex: new Map(),
		diagnostics: [],
		allServerNames: connections.map((c) => c.serverName),
	};
}

describe("formatMcpForPrompt", () => {
	it("returns empty string when no connections", () => {
		const result = makeResult([], []);
		expect(formatMcpForPrompt(result)).toBe("");
	});

	it("formats connected servers with their tools", () => {
		const result = makeResult(
			[{ serverName: "context7", toolCount: 2 }],
			[
				{ name: "mcp_context7_resolve-library-id", description: "[context7] Resolve a library ID" },
				{ name: "mcp_context7_query-docs", description: "[context7] Query documentation" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain("<available_mcp>");
		expect(output).toContain("</available_mcp>");
		expect(output).toContain("Only enabled MCP servers");
		expect(output).toContain('name="context7"');
		expect(output).toContain("mcp_context7_resolve-library-id");
		expect(output).toContain("mcp_context7_query-docs");
	});

	it("includes multiple servers", () => {
		const result = makeResult(
			[
				{ serverName: "context7", toolCount: 1 },
				{ serverName: "github", toolCount: 1 },
			],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain('name="context7"');
		expect(output).toContain('name="github"');
	});

	it("excludes tools from other servers", () => {
		const result = makeResult(
			[{ serverName: "context7", toolCount: 1 }],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result);
		expect(output).toContain("mcp_context7_query-docs");
		expect(output).not.toContain("mcp_github_create-issue");
	});
});

describe("mcpServerNameFromDescription", () => {
	it("returns the bracketed server name from a cast-stamped description", () => {
		expect(mcpServerNameFromDescription("[postgres] Query the database")).toBe("postgres");
		expect(mcpServerNameFromDescription("[playwright-staging] Click a button")).toBe("playwright-staging");
	});

	it("returns undefined for descriptions without the prefix", () => {
		expect(mcpServerNameFromDescription("no server prefix here")).toBeUndefined();
		expect(mcpServerNameFromDescription("[truncated")).toBeUndefined();
	});

	it("returns undefined when description is missing", () => {
		expect(mcpServerNameFromDescription(undefined)).toBeUndefined();
	});
});

describe("formatMcpForPrompt with persona allowlist", () => {
	it("returns the full catalog when no allowlist is given", () => {
		const result = makeResult(
			[
				{ serverName: "context7", toolCount: 1 },
				{ serverName: "github", toolCount: 1 },
			],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result, ["*"]);
		expect(output).toContain('name="context7"');
		expect(output).toContain('name="github"');
	});

	it("drops servers not named in the allowlist (and their tools)", () => {
		const result = makeResult(
			[
				{ serverName: "context7", toolCount: 1 },
				{ serverName: "github", toolCount: 1 },
			],
			[
				{ name: "mcp_context7_query-docs", description: "[context7] Query docs" },
				{ name: "mcp_github_create-issue", description: "[github] Create issue" },
			],
		);
		const output = formatMcpForPrompt(result, ["context7"]);
		expect(output).toContain('name="context7"');
		expect(output).toContain("mcp_context7_query-docs");
		expect(output).not.toContain('name="github"');
		expect(output).not.toContain("mcp_github_create-issue");
	});

	it("expands globs over server names", () => {
		const result = makeResult(
			[
				{ serverName: "playwright-prod", toolCount: 1 },
				{ serverName: "playwright-staging", toolCount: 1 },
				{ serverName: "postgres", toolCount: 1 },
			],
			[
				{ name: "mcp_playwright-prod_click", description: "[playwright-prod] click" },
				{ name: "mcp_playwright-staging_click", description: "[playwright-staging] click" },
				{ name: "mcp_postgres_query", description: "[postgres] query" },
			],
		);
		const output = formatMcpForPrompt(result, ["playwright-*"]);
		expect(output).toContain('name="playwright-prod"');
		expect(output).toContain('name="playwright-staging"');
		expect(output).not.toContain('name="postgres"');
		expect(output).not.toContain("mcp_postgres_query");
	});

	it("returns an empty catalog when the allowlist is empty", () => {
		const result = makeResult(
			[{ serverName: "context7", toolCount: 1 }],
			[{ name: "mcp_context7_query-docs", description: "[context7] Query docs" }],
		);
		expect(formatMcpForPrompt(result, [])).toBe("");
	});
});
