#!/usr/bin/env node
// Minimal real MCP server used as a test fixture for src/mcp.ts — deliberately
// not mocked, so the tests exercise the actual protocol handshake against the
// official SDK on both ends. Runs as stdio by default (`node mcp-echo-server.mjs`),
// or as a real HTTP server with `--http` (prints "LISTENING <port>" once up).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
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
			"memo",
			"blob:///assets/memo.txt",
			{ description: "text sent as a blob", mimeType: "text/plain" },
			async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", blob: "aGVsbG8gYmxvYg==" }] }),
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

	// Gated behind --prompts: prompts a person runs as slash commands, with and without arguments, one that seeds a
	// conversation, one with an embedded resource, one that fails.
	if (process.argv.includes("--prompts")) {
		server.registerPrompt(
			"review",
			{
				title: "Code review",
				description: "Review a piece of code",
				argsSchema: { code: z.string(), language: z.string().optional() },
			},
			({ code, language }) => ({
				messages: [{ role: "user", content: { type: "text", text: `Review this ${language ?? "code"}:\n${code}` } }],
			}),
		);
		server.registerPrompt(
			"explain",
			{ description: "Explain a topic", argsSchema: { topic: z.string() } },
			({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: `Explain ${topic}.` } }] }),
		);
		server.registerPrompt("triage", { description: "Triage a ticket" }, () => ({
			messages: [
				{ role: "user", content: { type: "text", text: "Triage the ticket." } },
				{ role: "assistant", content: { type: "text", text: "Which ticket?" } },
				{
					role: "user",
					content: { type: "resource", resource: { uri: "ticket://42", mimeType: "text/plain", text: "Printer on fire" } },
				},
			],
		}));
		server.registerPrompt("broken", { description: "Always fails" }, () => {
			throw new Error("prompt backend is down");
		});
	}

	// Gated behind --dynamic: the tool and prompt lists change while connected, and the server says so.
	if (process.argv.includes("--dynamic")) {
		server.registerTool("grow", { description: "Adds a tool and a prompt to the server." }, async () => {
			server.registerTool("grown", { description: "Appeared after connect." }, async () => ({
				content: [{ type: "text", text: "grown" }],
			}));
			server.registerPrompt("fresh", { description: "Appeared after connect" }, () => ({
				messages: [{ role: "user", content: { type: "text", text: "fresh prompt" } }],
			}));
			return { content: [{ type: "text", text: "grew" }] };
		});
		server.registerTool("shrink", { description: "Removes the grown tool." }, async () => {
			server._registeredTools.grown?.remove();
			return { content: [{ type: "text", text: "shrank" }] };
		});
		server.registerPrompt("seed", { description: "A prompt present from the start" }, () => ({
			messages: [{ role: "user", content: { type: "text", text: "seed" } }],
		}));
	}

	// Gated behind --progress: reports steps of a call, logs, reads the client's roots, returns structured output.
	if (process.argv.includes("--progress")) {
		server.server.registerCapabilities({ logging: {} });
		server.registerTool(
			"slow",
			{ description: "Takes three steps.", inputSchema: { steps: z.number().optional() } },
			async ({ steps }, extra) => {
				const total = steps ?? 3;
				for (let i = 1; i <= total; i++) {
					if (extra._meta?.progressToken !== undefined) {
						await extra.sendNotification({
							method: "notifications/progress",
							params: { progressToken: extra._meta.progressToken, progress: i, total, message: `step ${i}` },
						});
					// Real work takes time; a client drops a progress handler when the answer arrives.
					await new Promise((resolve) => setTimeout(resolve, 30));
					}
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		);
		server.registerTool("chatty", { description: "Logs two lines." }, async () => {
			await server.server.sendLoggingMessage({ level: "info", logger: "fixture", data: "first line" });
			await server.server.sendLoggingMessage({ level: "warning", data: { code: 7 } });
			return { content: [{ type: "text", text: "logged" }] };
		});
		server.registerTool("roots", { description: "Lists the client's roots." }, async () => {
			const { roots } = await server.server.listRoots();
			return { content: [{ type: "text", text: roots.map((r) => `${r.name} ${r.uri}`).join("\n") }] };
		});
		server.registerTool(
			"structured",
			{ description: "Returns only structured output.", outputSchema: { temperature: z.number() } },
			async () => ({ structuredContent: { temperature: 21 }, content: [] }),
		);
	}

	// Gated behind --ask: the server asks the client for a model answer and for a person's input.
	if (process.argv.includes("--ask")) {
		server.registerTool("ask-model", { description: "Asks the client's model.", inputSchema: { prompt: z.string() } }, async ({ prompt }) => {
			const answer = await server.server.createMessage({
				messages: [{ role: "user", content: { type: "text", text: prompt } }],
				maxTokens: 50,
			});
			return { content: [{ type: "text", text: `model said: ${answer.content.type === "text" ? answer.content.text : answer.content.type}` }] };
		});
		server.registerTool("ask-user", { description: "Asks the person for a name.", inputSchema: {} }, async () => {
			const answer = await server.server.elicitInput({
				message: "Who are you?",
				requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] },
			});
			return { content: [{ type: "text", text: `${answer.action}: ${JSON.stringify(answer.content ?? {})}` }] };
		});
	}

	// Gated behind --subscribe: resources can be subscribed to, and a tool says one of them changed.
	if (process.argv.includes("--subscribe")) {
		server.server.registerCapabilities({ resources: { subscribe: true } });
		const watched = new Set();
		server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
			watched.add(request.params.uri);
			return {};
		});
		server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
			watched.delete(request.params.uri);
			return {};
		});
		server.registerTool("touch", { description: "Says the readme changed.", inputSchema: {} }, async () => {
			await server.server.sendResourceUpdated({ uri: "file:///docs/readme.md" });
			return { content: [{ type: "text", text: `watched: ${[...watched].join(",")}` }] };
		});
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

// A server of the legacy HTTP+SSE kind: GET /sse opens the stream, POST /messages carries the requests.
if (process.argv.includes("--legacy-sse")) {
	const streams = new Map();
	const legacy = createServer(async (req, res) => {
		const url = new URL(req.url, "http://localhost");
		if (req.method === "GET" && url.pathname === "/sse") {
			const transport = new SSEServerTransport("/messages", res);
			streams.set(transport.sessionId, transport);
			await buildServer().connect(transport);
		} else if (req.method === "POST" && url.pathname === "/messages") {
			await streams.get(url.searchParams.get("sessionId"))?.handlePostMessage(req, res);
		} else {
			res.writeHead(405).end();
		}
	});
	legacy.listen(0, "127.0.0.1", () => {
		console.log(`LISTENING ${legacy.address().port}`);
	});
} else if (process.argv.includes("--http")) {
	// Stateless mode (sessionIdGenerator: undefined) — one transport per
	// request is simplest for a test fixture, no session bookkeeping needed.
	// With --stateful one server and transport live per session, so it can push to a client between its requests.
	const stateful = process.argv.includes("--stateful");
	const live = new Map();
	const httpServer = createServer(async (req, res) => {
		lastAuthHeader = req.headers["x-test-token"] ?? "none";
		const known = stateful ? live.get(req.headers["mcp-session-id"]) : undefined;
		if (known) return known.handleRequest(req, res);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: stateful ? () => randomUUID() : undefined,
			onsessioninitialized: (id) => live.set(id, transport),
		});
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
