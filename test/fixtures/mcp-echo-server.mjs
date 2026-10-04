#!/usr/bin/env node
// Minimal real MCP server used as a test fixture for src/mcp.ts — deliberately
// not mocked, so the tests exercise the actual protocol handshake against the
// official SDK on both ends. Runs as stdio by default (`node mcp-echo-server.mjs`),
// or as a real HTTP server with `--http` (prints "LISTENING <port>" once up).
import { createServer } from "node:http";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Set from the raw HTTP handler (below, HTTP mode only) before each request
// is dispatched to the MCP transport, so the "get-last-auth-header" tool can
// prove headers a client passed in its config actually made it onto the
// wire — exercised through the real connectMcpServers() call, not a
// separate manual fetch.
let lastAuthHeader = "none";

function buildServer() {
	// A docs-style server: resources and nothing else, so no tools/list at all.
	if (process.argv.includes("--resources-only")) {
		const only = new McpServer({ name: "resources-only-fixture", version: "1.0.0" });
		only.registerResource("note", "notes:///only", { mimeType: "text/plain" }, async (uri) => ({
			contents: [{ uri: uri.href, mimeType: "text/plain", text: "the only note" }],
		}));
		return only;
	}
	const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

	server.registerTool(
		"echo",
		{ description: "Echoes back the given text.", inputSchema: { text: z.string() } },
		async ({ text }) => ({ content: [{ type: "text", text }] }),
	);

	server.registerTool(
		"add",
		{ description: "Adds two numbers.", inputSchema: { a: z.number(), b: z.number() } },
		async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
	);

	server.registerTool("fails", { description: "Always returns a tool error." }, async () => ({
		content: [{ type: "text", text: "deliberate failure" }],
		isError: true,
	}));

	server.registerTool("get-last-auth-header", { description: "Returns the X-Test-Token header of the last HTTP request." }, async () => ({
		content: [{ type: "text", text: lastAuthHeader }],
	}));

	// Gated behind --rich so the default fixture (used by most tests, which
	// assert an exact tool count/name list) stays unchanged. Exercises every
	// MCP content-block type in one response: two images (to check that only
	// the first becomes imageDataUrl and the rest are noted, not silently
	// dropped), audio, a resource_link, and an embedded (inline) resource.
	if (process.argv.includes("--rich")) {
		server.registerTool("rich-content", { description: "Returns every MCP content type in one result." }, async () => ({
			content: [
				{ type: "text", text: "hello text" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "image", data: "d29ybGQ=", mimeType: "image/png" },
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "file:///tmp/example.txt",
					name: "example.txt",
					description: "an example file",
				},
				{
					type: "resource",
					resource: { uri: "file:///tmp/inline.txt", mimeType: "text/plain", text: "inline resource text" },
				},
			],
		}));
	}

	// Gated behind --paginate: replaces the auto-generated tools/list handler
	// with one that hands out two tools across two pages, so tests can prove
	// connectMcpServers() actually follows nextCursor instead of only reading
	// the first page.
	if (process.argv.includes("--paginate")) {
		const pages = [
			{ name: "page-a", description: "First page tool.", inputSchema: { type: "object", properties: {} } },
			{ name: "page-b", description: "Second page tool.", inputSchema: { type: "object", properties: {} } },
		];
		server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
			if (!request.params?.cursor) return { tools: [pages[0]], nextCursor: "page2" };
			return { tools: [pages[1]] };
		});
		server.server.setRequestHandler(CallToolRequestSchema, async (request) => ({
			content: [{ type: "text", text: `called ${request.params.name}` }],
		}));
	}

	if (process.argv.includes("--fat")) {
		// Returns a payload far larger than any context window, to pin the cap.
		server.registerTool("fat", { description: "Returns a huge blob." }, async () => ({
			content: [{ type: "text", text: "A".repeat(3 * 1024 * 1024) }],
		}));
	}

	// Gated behind --resources: a server that offers resources besides tools (text, an image, other binary, and a
	// template), so the default fixture keeps declaring no `resources` capability.
	if (process.argv.includes("--resources")) {
		server.registerResource(
			"readme",
			"file:///docs/readme.md",
			{ title: "Readme", description: "the project readme", mimeType: "text/markdown" },
			async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Readme\nDeploy step 3 is: flush the cache." }] }),
		);
		server.registerResource(
			"logo",
			"blob:///assets/logo.png",
			{ description: "the logo", mimeType: "image/png" },
			async (uri) => ({ contents: [{ uri: uri.href, mimeType: "image/png", blob: "aGVsbG8=" }] }),
		);
		server.registerResource(
			"archive",
			"blob:///assets/data.bin",
			{ description: "an archive", mimeType: "application/octet-stream" },
			async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/octet-stream", blob: "AAECAwQFBgcICQ==" }] }),
		);
		server.registerResource(
			"note",
			new ResourceTemplate("notes://{id}", { list: undefined }),
			{ description: "a note by id", mimeType: "text/plain" },
			async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: `note ${id}` }] }),
		);
	}

	// Gated behind --resources-paged: resources across two pages, to prove the listing follows nextCursor.
	if (process.argv.includes("--resources-paged")) {
		server.server.registerCapabilities({ resources: {} });
		server.server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
			request.params?.cursor
				? { resources: [{ uri: "page:///two", name: "page two" }] }
				: { resources: [{ uri: "page:///one", name: "page one" }], nextCursor: "p2" },
		);
		server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
		server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
			contents: [{ uri: request.params.uri, text: `read ${request.params.uri}` }],
		}));
	}

	// Declares the capability but refuses to list: a server that is broken for resources, not for tools.
	if (process.argv.includes("--resources-broken")) {
		server.server.registerCapabilities({ resources: {} });
		server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
			throw new Error("resources are down");
		});
		server.server.setRequestHandler(ReadResourceRequestSchema, async () => {
			throw new Error("no such thing");
		});
	}

	// Has a tool of its own with the name the resource tools would take, and offers resources.
	if (process.argv.includes("--resources-own-tool")) {
		server.registerTool("list_resources", { description: "The server's own listing." }, async () => ({
			content: [{ type: "text", text: "own listing" }],
		}));
		server.server.registerCapabilities({ resources: {} });
		server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
		server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
			contents: [{ uri: request.params.uri, text: "own read" }],
		}));
	}

	if (process.argv.includes("--hang-list-tools")) {
		server.server.setRequestHandler(ListToolsRequestSchema, async () => new Promise(() => {}));
	}

	return server;
}

if (process.argv.includes("--http")) {
	// Stateless mode (sessionIdGenerator: undefined) — one transport per
	// request is simplest for a test fixture, no session bookkeeping needed.
	const httpServer = createServer(async (req, res) => {
		lastAuthHeader = req.headers["x-test-token"] ?? "none";
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		const server = buildServer();
		await server.connect(transport);
		await transport.handleRequest(req, res);
	});
	httpServer.listen(0, "127.0.0.1", () => {
		console.log(`LISTENING ${httpServer.address().port}`);
	});
} else {
	await buildServer().connect(new StdioServerTransport());
}
