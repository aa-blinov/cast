/**
 * Stable, integration-facing HTTP contract. The browser's older `/api/*`
 * surface deliberately remains independent: it can evolve with the bundled UI
 * while these routes retain their URL and schema compatibility within v1.
 */

export const API_V1_PREFIX = "/api/v1";
export const OPENAPI_V1_PATH = `${API_V1_PREFIX}/openapi.json`;

interface StableRoute {
	method: string;
	legacyPath: RegExp;
}

const STABLE_API_V1_ROUTES: StableRoute[] = [
	{ method: "GET", legacyPath: /^\/api\/server\/status$/ },
	{ method: "GET", legacyPath: /^\/api\/server\/identity$/ },
	{
		method: "GET",
		legacyPath:
			/^\/api\/(personas|persona-content|git-info|config|commands|themes|models|models\/cached|skill-content|suggest)$/,
	},
	{ method: "POST", legacyPath: /^\/api\/(settings\/command|ssh\/key|ssh\/add|provider\/verify)$/ },
	{ method: "GET", legacyPath: /^\/api\/settings\/(appearance|reasoning-options)$/ },
	{ method: "POST", legacyPath: /^\/api\/settings\/appearance$/ },
	{ method: "GET", legacyPath: /^\/api\/sessions\/events$/ },
	{ method: "GET", legacyPath: /^\/api\/sessions$/ },
	{ method: "POST", legacyPath: /^\/api\/sessions$/ },
	{
		method: "GET",
		legacyPath:
			/^\/api\/sessions\/[^/]+(\/(history|events|events\/history|image|audio|diff|diff\/file|undo|fork-preview|reasoning-options|fs|fs\/search|fs\/download|inputs|inputs\/download))?$/,
	},
	{ method: "DELETE", legacyPath: /^\/api\/sessions\/[^/]+(\/(permanent|share|fs|inputs))?$/ },
	{
		method: "POST",
		legacyPath:
			/^\/api\/sessions\/[^/]+\/(fork|chat|abort|retry|steer|followup|command|mode|question|bash-confirm|plan-transition|clean-context|rename|pin|share|background\/kill|fs\/rename|fs\/create|fs\/move|fs\/delete|inputs\/upload)$/,
	},
	{ method: "PUT", legacyPath: /^\/api\/sessions\/[^/]+\/(fs\/upload|inputs\/upload)$/ },
	{ method: "GET", legacyPath: /^\/api\/browse$/ },
	{ method: "POST", legacyPath: /^\/api\/browse\/mkdir$/ },
	{ method: "DELETE", legacyPath: /^\/api\/browse$/ },
];

/** Map a v1 URL to the existing handler path without duplicating daemon logic. */
export function legacyPathForApiV1(urlPath: string): string | undefined {
	if (urlPath === OPENAPI_V1_PATH) return "/api/openapi.json";
	if (!urlPath.startsWith(`${API_V1_PREFIX}/`)) return undefined;
	return `/api/${urlPath.slice(`${API_V1_PREFIX}/`.length)}`;
}

export function isStableApiV1Route(method: string, legacyPath: string): boolean {
	return STABLE_API_V1_ROUTES.some((route) => route.method === method && route.legacyPath.test(legacyPath));
}

type OpenApiObject = Record<string, unknown>;

const errorResponse: OpenApiObject = {
	description: "Request failed",
	content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const idParameter: OpenApiObject = {
	name: "id",
	in: "path",
	required: true,
	schema: { type: "string" },
	description: "Cast session identifier.",
};

const authenticated: OpenApiObject[] = [{ loopbackBearer: [] }, { webSession: [] }];

const jsonResponse = (description: string, schema: OpenApiObject): OpenApiObject => ({
	description,
	content: { "application/json": { schema } },
});

const requestBody = (schema: OpenApiObject): OpenApiObject => ({
	required: true,
	content: { "application/json": { schema } },
});

const additionalApiV1Paths: OpenApiObject = {
	"/api/v1/personas": {
		get: { summary: "List personas", responses: { "200": jsonResponse("Personas", { type: "array" }) } },
	},
	"/api/v1/git-info": {
		get: {
			summary: "Inspect a working directory's Git state",
			responses: { "200": jsonResponse("Git state", { type: "object" }) },
		},
	},
	"/api/v1/config": {
		get: {
			summary: "Read the safe client configuration",
			responses: { "200": jsonResponse("Configuration", { type: "object" }) },
		},
	},
	"/api/v1/commands": {
		get: { summary: "List slash commands", responses: { "200": jsonResponse("Commands", { type: "array" }) } },
	},
	"/api/v1/themes": {
		get: { summary: "List themes", responses: { "200": jsonResponse("Themes", { type: "array" }) } },
	},
	"/api/v1/models": {
		get: { summary: "Discover provider models", responses: { "200": jsonResponse("Models", { type: "array" }) } },
	},
	"/api/v1/models/cached": {
		get: { summary: "Read cached provider models", responses: { "200": jsonResponse("Models", { type: "array" }) } },
	},
	"/api/v1/skill-content": {
		get: {
			summary: "Read a skill's content",
			responses: { "200": jsonResponse("Skill content", { type: "object" }) },
		},
	},
	"/api/v1/persona-content": {
		get: {
			summary: "Read a persona's content",
			responses: { "200": jsonResponse("Persona content", { type: "object" }) },
		},
	},
	"/api/v1/suggest": {
		get: {
			summary: "Get composer suggestions",
			responses: { "200": jsonResponse("Suggestions", { type: "array" }) },
		},
	},
	"/api/v1/settings/appearance": {
		get: {
			summary: "Read appearance settings",
			responses: { "200": jsonResponse("Appearance", { type: "object" }) },
		},
		post: {
			summary: "Update appearance settings",
			requestBody: requestBody({
				type: "object",
				required: ["showReasoning"],
				properties: { showReasoning: { type: "boolean" } },
				additionalProperties: false,
			}),
			responses: { "200": jsonResponse("Updated appearance", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/settings/reasoning-options": {
		get: {
			summary: "List global reasoning options",
			responses: { "200": jsonResponse("Reasoning options", { type: "object" }) },
		},
	},
	"/api/v1/settings/command": {
		post: {
			summary: "Run a supported global settings command",
			requestBody: requestBody({ $ref: "#/components/schemas/CommandRequest" }),
			responses: { "200": jsonResponse("Command result", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/ssh/key": {
		post: {
			summary: "Configure an SSH key",
			requestBody: requestBody({ $ref: "#/components/schemas/SshKeyRequest" }),
			responses: { "200": jsonResponse("Configured SSH key", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/ssh/add": {
		post: {
			summary: "Add an SSH host",
			requestBody: requestBody({ $ref: "#/components/schemas/SshHostRequest" }),
			responses: { "200": jsonResponse("Added SSH host", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/provider/verify": {
		post: {
			summary: "Verify provider credentials",
			requestBody: requestBody({ $ref: "#/components/schemas/ProviderVerificationRequest" }),
			responses: { "200": jsonResponse("Verification", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/browse": {
		get: {
			summary: "Browse a permitted directory",
			responses: { "200": jsonResponse("Directory listing", { type: "object" }), "400": errorResponse },
		},
		delete: {
			summary: "Delete a selected directory entry",
			responses: { "200": jsonResponse("Deleted", { $ref: "#/components/schemas/Ok" }), "400": errorResponse },
		},
	},
	"/api/v1/browse/mkdir": {
		post: {
			summary: "Create a directory in the browser root",
			requestBody: requestBody({ type: "object" }),
			responses: { "200": jsonResponse("Created", { $ref: "#/components/schemas/Ok" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/events": {
		get: {
			summary: "Subscribe to all session updates",
			responses: {
				"200": {
					description: "SSE stream",
					content: { "text/event-stream": { schema: { $ref: "#/components/schemas/WebEvent" } } },
				},
			},
		},
	},
	"/api/v1/sessions/{id}/events/history": {
		get: {
			summary: "Read execution event audit trail",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Event history", { type: "object" }), "404": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/image": {
		get: {
			summary: "Download a persisted message image",
			parameters: [idParameter],
			responses: {
				"200": {
					description: "Image bytes",
					content: { "image/*": { schema: { type: "string", format: "binary" } } },
				},
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/audio": {
		get: {
			summary: "Download a voice message from a user turn",
			parameters: [idParameter],
			responses: {
				"200": {
					description: "WAV bytes; honours Range",
					content: { "audio/wav": { schema: { type: "string", format: "binary" } } },
				},
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/permanent": {
		delete: {
			summary: "Permanently delete a session",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Deleted", { $ref: "#/components/schemas/Ok" }), "404": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/rename": {
		post: {
			summary: "Rename a session",
			parameters: [idParameter],
			requestBody: requestBody({ type: "object", required: ["title"], properties: { title: { type: "string" } } }),
			responses: {
				"200": jsonResponse("Renamed", { type: "object" }),
				"400": errorResponse,
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/pin": {
		post: {
			summary: "Pin or unpin a session",
			parameters: [idParameter],
			requestBody: requestBody({
				type: "object",
				required: ["pinned"],
				properties: { pinned: { type: "boolean" } },
			}),
			responses: {
				"200": jsonResponse("Pinned state", { type: "object" }),
				"400": errorResponse,
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/share": {
		post: {
			summary: "Create a share link",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Share link", { type: "object" }), "404": errorResponse },
		},
		delete: {
			summary: "Revoke a share link",
			parameters: [idParameter],
			responses: {
				// `ok: false` at 200 when the session wasn't shared in the first
				// place — not an Ok, which is `ok: const true`.
				"200": jsonResponse("Revoked, or already not shared", {
					type: "object",
					required: ["ok"],
					properties: { ok: { type: "boolean" } },
				}),
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/diff": {
		get: {
			summary: "Read the session working tree diff",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Diff", { type: "object" }) },
		},
	},
	"/api/v1/sessions/{id}/diff/file": {
		get: {
			summary: "Read the diff of one changed file",
			description:
				"The diff endpoint lists every change but carries hunks for only the first few hundred files; this returns the hunks of one path.",
			parameters: [idParameter, { name: "path", in: "query", required: true, schema: { type: "string" } }],
			responses: { "200": jsonResponse("Diff of one file", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fork-preview": {
		get: {
			summary: "Whether a fork at a point can have its own copy of the files",
			description:
				"Nothing is changed. Pass beforeSeq or afterSeq as for a fork (none means the whole session). canCopyFiles says whether POST fork with withFiles will work; kind is worktree or snapshot, reason says why not.",
			parameters: [
				idParameter,
				{ name: "beforeSeq", in: "query", schema: { type: "integer" } },
				{ name: "afterSeq", in: "query", schema: { type: "integer" } },
			],
			responses: {
				"200": jsonResponse("Fork files preview", { type: "object" }),
				"400": errorResponse,
				"404": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/undo": {
		get: {
			summary: "Preview what undoing the last turn would do",
			description:
				"Nothing is changed. available says whether /undo can run now (reason says why not). kind is git, snapshot or files: how the folder is restored, and shellChangesCovered is false when only edit/write changes come back. removedMessage and removedMessages name what leaves the conversation. lost lists (at most 20 of lostTotal) the files created since the checkpoint that the restore deletes; POST the command /undo --force to proceed when it is not empty.",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Undo preview", { type: "object" }), "404": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/reasoning-options": {
		get: {
			summary: "List session reasoning options",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Reasoning options", { type: "object" }) },
		},
	},
	"/api/v1/sessions/{id}/fs": {
		get: {
			summary: "List a session folder",
			description:
				"Folders first, then files; ignored, link and broken flags per entry. Long folders come in pages: pass offset and limit (default 1000, max 5000) and read hasMore.",
			parameters: [
				idParameter,
				{ name: "path", in: "query", schema: { type: "string" } },
				{ name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
				{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000 } },
			],
			responses: { "200": jsonResponse("File listing", { type: "object" }) },
		},
		delete: {
			summary: "Delete a session file",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Deleted", { $ref: "#/components/schemas/Ok" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fs/search": {
		get: {
			summary: "Search session files and folders by name",
			description:
				"Every word of q must appear in the path. The answer carries total and truncated, so a capped list is never mistaken for the whole result. Git-ignored paths are skipped unless ignored=1.",
			parameters: [
				idParameter,
				{ name: "q", in: "query", required: true, schema: { type: "string" } },
				{ name: "ignored", in: "query", schema: { type: "string", enum: ["1"] } },
			],
			responses: { "200": jsonResponse("Search results", { type: "object" }) },
		},
	},
	"/api/v1/sessions/{id}/fs/download": {
		get: {
			summary: "Download a session file or folder",
			description: "Supports byte ranges (Range, answered with 206 or 416). A folder is streamed as a tar.gz.",
			parameters: [idParameter, { name: "path", in: "query", required: true, schema: { type: "string" } }],
			responses: {
				"200": {
					description: "File bytes",
					content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
				},
				"206": { description: "The requested byte range" },
				"416": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/fs/rename": {
		post: {
			summary: "Rename a session file",
			parameters: [idParameter],
			requestBody: requestBody({ type: "object" }),
			responses: { "200": jsonResponse("Renamed", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fs/create": {
		post: {
			summary: "Create a file or folder",
			description: "name may be a nested path such as a/b/c.txt; missing folders are created. 409 when it exists.",
			parameters: [idParameter],
			requestBody: requestBody({
				type: "object",
				required: ["name", "type"],
				properties: {
					path: { type: "string", description: "Parent folder, empty for the project root" },
					name: { type: "string" },
					type: { type: "string", enum: ["file", "dir"] },
				},
			}),
			responses: { "201": jsonResponse("Created", { type: "object" }), "400": errorResponse, "409": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fs/move": {
		post: {
			summary: "Move a file or folder into another folder",
			description: "409 when the destination already has that name; a folder can't move into itself.",
			parameters: [idParameter],
			requestBody: requestBody({
				type: "object",
				required: ["path", "to"],
				properties: { path: { type: "string" }, to: { type: "string", description: "Destination folder" } },
			}),
			responses: { "200": jsonResponse("Moved", { type: "object" }), "400": errorResponse, "409": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fs/delete": {
		post: {
			summary: "Delete several files or folders",
			description: "Each path succeeds or fails on its own; the answer lists both.",
			parameters: [idParameter],
			requestBody: requestBody({
				type: "object",
				required: ["paths"],
				properties: { paths: { type: "array", items: { type: "string" } } },
			}),
			responses: { "200": jsonResponse("Per-path result", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/fs/upload": {
		put: {
			summary: "Upload a file into the project",
			description:
				"The request body is the raw file, streamed to disk. 409 when the file exists unless overwrite=1; 413 above 1 GiB.",
			parameters: [
				idParameter,
				{ name: "path", in: "query", required: true, schema: { type: "string" } },
				{ name: "overwrite", in: "query", schema: { type: "string", enum: ["1"] } },
			],
			requestBody: {
				required: true,
				content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
			},
			responses: {
				"201": jsonResponse("Uploaded", { type: "object" }),
				"400": errorResponse,
				"409": errorResponse,
				"413": errorResponse,
			},
		},
	},
	"/api/v1/sessions/{id}/inputs": {
		get: {
			summary: "List session attachments",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Attachments", { type: "object" }) },
		},
		delete: {
			summary: "Delete a session attachment",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Deleted", { $ref: "#/components/schemas/Ok" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/inputs/upload": {
		post: {
			summary: "Upload a session attachment",
			parameters: [idParameter],
			requestBody: requestBody({ type: "object", required: ["name", "dataUrl"] }),
			responses: { "200": jsonResponse("Uploaded attachment", { type: "object" }), "400": errorResponse },
		},
		put: {
			summary: "Upload a session attachment as a raw body",
			description: "Streams the file to disk instead of a base64 data URL; the name goes in the query.",
			parameters: [idParameter, { name: "name", in: "query", required: true, schema: { type: "string" } }],
			requestBody: {
				required: true,
				content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
			},
			responses: { "200": jsonResponse("Uploaded attachment", { type: "object" }), "400": errorResponse },
		},
	},
	"/api/v1/sessions/{id}/inputs/download": {
		get: {
			summary: "Download a session attachment",
			parameters: [idParameter],
			responses: {
				"200": {
					description: "Attachment bytes",
					content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
				},
			},
		},
	},
};

/** OpenAPI 3.1 document served verbatim by `/api/v1/openapi.json`. */
export const apiV1OpenApiDocument: OpenApiObject = {
	openapi: "3.1.1",
	info: {
		title: "Cast API",
		version: "1.0.0",
		description:
			"Stable local integration API for a Cast daemon. Existing /api/* endpoints power the bundled web UI; use /api/v1/* for integrations.",
	},
	servers: [{ url: "/", description: "The running Cast daemon" }],
	security: authenticated,
	paths: {
		...additionalApiV1Paths,
		"/api/v1/openapi.json": {
			get: {
				summary: "Get this OpenAPI document",
				security: [],
				responses: { "200": jsonResponse("OpenAPI document", { type: "object" }) },
			},
		},
		"/api/v1/server/status": {
			get: {
				summary: "Get daemon status",
				responses: {
					"200": jsonResponse("Daemon status", { $ref: "#/components/schemas/DaemonStatus" }),
					"401": errorResponse,
				},
			},
		},
		"/api/v1/server/identity": {
			get: {
				summary: "Verify daemon process identity",
				responses: {
					"200": jsonResponse("Daemon identity", { $ref: "#/components/schemas/DaemonIdentity" }),
					"401": errorResponse,
				},
			},
		},
		"/api/v1/sessions": {
			get: {
				summary: "List sessions",
				description:
					"Returns a plain array by default. Passing `limit` or `offset` switches the body to a paged object — clients that add paging must handle both shapes.",
				parameters: [
					{ name: "q", in: "query", schema: { type: "string" }, description: "Optional text search." },
					{
						name: "limit",
						in: "query",
						schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
						description: "Page size. Presence of this or `offset` changes the response shape (see above).",
					},
					{
						name: "offset",
						in: "query",
						schema: { type: "integer", minimum: 0, default: 0 },
						description: "Page offset. Presence of this or `limit` changes the response shape (see above).",
					},
				],
				responses: {
					"200": jsonResponse("Session summaries — an array, or a paged object when limit/offset is given", {
						oneOf: [
							{ type: "array", items: { $ref: "#/components/schemas/SessionSummary" } },
							{
								type: "object",
								required: ["sessions", "total", "limit", "offset"],
								properties: {
									sessions: { type: "array", items: { $ref: "#/components/schemas/SessionSummary" } },
									total: { type: "integer" },
									limit: { type: "integer" },
									offset: { type: "integer" },
								},
							},
						],
					}),
					"401": errorResponse,
				},
			},
			post: {
				summary: "Create a session",
				requestBody: requestBody({ $ref: "#/components/schemas/CreateSessionRequest" }),
				responses: {
					"201": jsonResponse("Created session", { $ref: "#/components/schemas/CreateSessionResponse" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}": {
			get: {
				summary: "Get a session and its recent history",
				parameters: [idParameter, { name: "turns", in: "query", schema: { type: "integer", minimum: 1 } }],
				responses: {
					"200": jsonResponse("Session", { $ref: "#/components/schemas/Session" }),
					"401": errorResponse,
					"404": errorResponse,
				},
			},
			delete: {
				summary: "Unload a session from the daemon",
				parameters: [idParameter],
				responses: {
					"200": jsonResponse("Session unloaded", { $ref: "#/components/schemas/Ok" }),
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/fork": {
			post: {
				summary: "Fork an idle session",
				parameters: [idParameter],
				requestBody: requestBody({ $ref: "#/components/schemas/ForkRequest" }),
				responses: {
					"201": jsonResponse("Forked session", { $ref: "#/components/schemas/CreateSessionResponse" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/chat": {
			post: {
				summary: "Start an agent turn",
				parameters: [idParameter],
				requestBody: requestBody({ $ref: "#/components/schemas/ChatRequest" }),
				responses: {
					"202": jsonResponse("Turn accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"500": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/abort": {
			post: {
				summary: "Abort the current turn",
				parameters: [idParameter],
				responses: {
					"200": jsonResponse("Abort requested", { $ref: "#/components/schemas/Ok" }),
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/retry": {
			post: {
				summary: "Re-run a turn that failed or was stopped, from the saved history",
				parameters: [idParameter],
				responses: {
					"200": jsonResponse("Turn restarted", { $ref: "#/components/schemas/Ok" }),
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/steer": {
			post: {
				summary: "Inject a message into the current turn",
				parameters: [idParameter],
				requestBody: requestBody({ $ref: "#/components/schemas/MessageRequest" }),
				responses: {
					"202": jsonResponse("Steer accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/followup": {
			post: {
				summary: "Queue a follow-up turn",
				parameters: [idParameter],
				requestBody: requestBody({ $ref: "#/components/schemas/MessageRequest" }),
				responses: {
					"202": jsonResponse("Follow-up accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/command": {
			post: {
				summary: "Run a supported slash command",
				parameters: [idParameter],
				requestBody: requestBody({ $ref: "#/components/schemas/CommandRequest" }),
				responses: {
					"200": jsonResponse("Command result", { $ref: "#/components/schemas/CommandResponse" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/mode": {
			post: {
				summary: "Set session mode",
				parameters: [idParameter],
				requestBody: requestBody({
					type: "object",
					required: ["mode"],
					properties: { mode: { enum: ["plan", "build"] } },
				}),
				responses: {
					"200": jsonResponse("Mode changed", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/question": {
			post: {
				summary: "Answer a pending question",
				parameters: [idParameter],
				requestBody: requestBody({
					type: "object",
					required: ["values"],
					properties: {
						values: {
							type: "array",
							description:
								"One entry per question. A multi-select answer is itself an array of the chosen values.",
							items: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
						},
					},
				}),
				responses: {
					"202": jsonResponse("Answer accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/bash-confirm": {
			post: {
				summary: "Answer a pending dangerous-command confirmation",
				description:
					"The daemon runs the agent loop, so its dangerous-command gate asks the connected clients. The turn stays blocked until this is answered or the request times out (denied).",
				parameters: [idParameter],
				requestBody: requestBody({
					type: "object",
					required: ["id", "allow"],
					properties: {
						id: { type: "string", description: "The id carried by the bash_confirm event." },
						allow: { type: "boolean", description: "True runs the command once; false blocks it." },
						always: {
							type: "boolean",
							description:
								"With allow, also saves the event's rule to the user's permissions.approved, so it isn't asked again.",
						},
					},
				}),
				responses: {
					"202": jsonResponse("Answer accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/plan-transition": {
			post: {
				summary: "Resolve a plan completion transition",
				parameters: [idParameter],
				requestBody: requestBody({ type: "object", required: ["kind"], properties: { kind: { const: "done" } } }),
				responses: {
					"202": jsonResponse("Transition accepted", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/clean-context": {
			post: {
				summary: "Clear a session's in-context working set",
				parameters: [idParameter],
				responses: {
					"200": jsonResponse("Context cleared", { $ref: "#/components/schemas/Ok" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
					"409": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/events": {
			get: {
				summary: "Subscribe to session events",
				parameters: [idParameter],
				responses: {
					"200": {
						description: "SSE stream of WebEvent JSON payloads",
						content: { "text/event-stream": { schema: { $ref: "#/components/schemas/WebEvent" } } },
					},
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
		"/api/v1/sessions/{id}/history": {
			get: {
				summary: "Load older session history",
				parameters: [
					idParameter,
					{ name: "before", in: "query", required: true, schema: { type: "integer" } },
					{ name: "turns", in: "query", schema: { type: "integer", minimum: 1 } },
				],
				responses: {
					"200": jsonResponse("History page", { $ref: "#/components/schemas/HistoryPage" }),
					"400": errorResponse,
					"401": errorResponse,
					"404": errorResponse,
				},
			},
		},
	},
	components: {
		securitySchemes: {
			loopbackBearer: {
				type: "http",
				scheme: "bearer",
				description: "Token from server.json; accepted only from localhost.",
			},
			webSession: {
				type: "apiKey",
				in: "cookie",
				name: "cast_web_session",
				description: "Authenticated web session cookie.",
			},
		},
		schemas: {
			Error: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
			Ok: { type: "object", required: ["ok"], properties: { ok: { const: true } } },
			DaemonStatus: {
				type: "object",
				required: ["running"],
				properties: {
					running: { type: "boolean" },
					pid: { type: "integer" },
					host: { type: "string" },
					port: { type: "integer" },
					startedAt: { type: "string" },
					foreground: { type: "boolean" },
				},
			},
			DaemonIdentity: { type: "object", properties: { instanceId: { type: "string" } } },
			SessionSummary: {
				type: "object",
				required: ["id"],
				properties: {
					id: { type: "string" },
					title: { type: "string" },
					cwd: { type: "string" },
					model: { type: "string" },
					persona: { type: "string" },
					status: { enum: ["idle", "running", "error"] },
					updatedAt: { type: "string" },
					createdAt: { type: "string" },
					pinned: { type: "boolean" },
					messageCount: { type: "integer", description: "Turns in the session, as the sidebar counts them." },
					isSandbox: {
						type: "boolean",
						description: "True when the session runs in a throwaway sandbox directory.",
					},
				},
			},
			Session: {
				type: "object",
				required: ["id", "status", "messages"],
				properties: {
					id: { type: "string" },
					persona: { type: "string" },
					model: { type: "string" },
					cwd: { type: "string" },
					mode: { enum: ["plan", "build"] },
					status: { enum: ["idle", "running", "error"] },
					messages: { type: "array", items: { type: "object" } },
					streaming: { type: "array", items: { type: "object" } },
					hasMoreHistory: { type: "boolean" },
					oldestSeq: { type: ["integer", "null"] },
					// Everything below was returned but undeclared: a client
					// generated from this contract could not see the title, the
					// usage totals or the timestamps — most of what a session
					// listing is for.
					title: { type: "string" },
					pinned: { type: "boolean" },
					audioInput: {
						type: "boolean",
						description:
							"Whether the model of the next turn accepts voice messages (`data:audio/wav` in `images`).",
					},
					shareToken: { type: ["string", "null"], description: "Public share token, when the session is shared." },
					sessionKind: {
						type: "string",
						enum: ["conversation", "background", "subagent"],
						description: '"subagent" for a task subagent\'s session, which opens view-only.',
					},
					parentSessionId: {
						type: ["string", "null"],
						description: "The conversation a subagent session belongs to.",
					},
					turnStartedAt: { type: ["integer", "null"], description: "Epoch ms the in-flight turn began." },
					question: { type: ["object", "null"], description: "Pending question awaiting an answer." },
					planTransition: { type: ["object", "null"] },
					bashConfirm: {
						type: ["object", "null"],
						description:
							"The confirmation the turn is waiting on (same shape as the bash_confirm event), or null.",
					},
					usage: { type: "object", description: "Token and cost totals for the session." },
					backgroundTasks: {
						type: "array",
						description: "Background bash tasks still running for this session.",
						items: {
							type: "object",
							required: ["id", "command"],
							properties: {
								id: { type: "string" },
								command: { type: "string" },
								startedAt: { type: "integer", description: "Epoch ms." },
							},
						},
					},
					createdAt: { type: "string" },
					updatedAt: { type: "string" },
				},
			},
			CreateSessionRequest: {
				type: "object",
				properties: {
					persona: { type: "string" },
					model: { type: "string" },
					provider: { type: "string", description: "Pin the session to a saved provider by name." },
					cwd: { type: "string", description: '"sandbox" for a throwaway directory, or an absolute path.' },
					worktree: { type: "string", description: "Mutually exclusive with a sandbox cwd." },
					agentId: {
						type: "string",
						description: "Spawn from a saved agent; its persona/model/provider override the fields above.",
					},
				},
			},
			CreateSessionResponse: {
				type: "object",
				required: ["id", "session"],
				properties: { id: { type: "string" }, session: { type: "object" } },
			},
			ForkRequest: {
				type: "object",
				properties: {
					beforeSeq: {
						type: "integer",
						description:
							"Fork the history before the message with this `seq` (a user message, from history) instead of the whole current context.",
					},
					withFiles: {
						type: "boolean",
						description:
							"Give the fork its own folder with the files as they were at that point: a git worktree at the snapshot in a repository, or a copy of the hidden snapshot in a new sandbox folder. 409 with the reason when there is no snapshot for that point (an older session, a folder too big to snapshot) or when the fork is the whole session. GET fork-preview says beforehand.",
					},
					afterSeq: {
						type: "integer",
						description:
							"Fork the history through the agent's answer with this `seq`, keeping it. Must be an answer that ends a turn (no tool calls); 400 otherwise. The last answer is the whole session. Send one of beforeSeq or afterSeq, not both.",
					},
				},
			},
			ChatRequest: {
				type: "object",
				properties: {
					text: { type: "string" },
					images: {
						type: "array",
						maxItems: 6,
						description:
							"data: URLs. Images, or one voice message as `data:audio/wav;base64,...` when the session's `audioInput` is true.",
						items: { type: "string", contentEncoding: "base64" },
					},
					clientMessageId: { type: "string", maxLength: 200 },
					goal: {
						description:
							"Make the message a goal, like /goal: the text becomes the session's objective, which persists and drives later turns until the agent closes it. `true` gives the goal's first turn the default iteration budget, a number (1-200) sets it. With a goal already active, the message just runs under it.",
						oneOf: [{ type: "boolean" }, { type: "integer", minimum: 1, maximum: 200 }],
					},
				},
				anyOf: [{ required: ["text"] }, { required: ["images"] }],
			},
			MessageRequest: {
				type: "object",
				required: ["message"],
				properties: { message: { type: "string", minLength: 1 } },
			},
			CommandRequest: {
				type: "object",
				required: ["command"],
				properties: { command: { type: "string", minLength: 1 } },
			},
			CommandResponse: { type: "object", required: ["ok"], properties: { ok: { const: true }, result: {} } },
			SshKeyRequest: {
				type: "object",
				required: ["name", "key"],
				properties: { name: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } },
				additionalProperties: false,
			},
			SshHostRequest: {
				type: "object",
				required: ["name", "host"],
				properties: {
					name: { type: "string", minLength: 1 },
					host: { type: "string", minLength: 1 },
					username: { type: "string" },
					port: { type: "integer", minimum: 1, maximum: 65535 },
					keyPath: { type: "string" },
					password: { type: "string" },
				},
				additionalProperties: false,
			},
			ProviderVerificationRequest: {
				type: "object",
				required: ["url", "apiKey"],
				properties: { url: { type: "string", minLength: 1 }, apiKey: { type: "string", minLength: 1 } },
				additionalProperties: false,
			},
			HistoryPage: {
				type: "object",
				required: ["messages", "hasMoreHistory"],
				properties: {
					messages: { type: "array", items: { type: "object" } },
					oldestSeq: { type: ["integer", "null"] },
					hasMoreHistory: { type: "boolean" },
				},
			},
			WebEvent: {
				type: "object",
				required: ["type"],
				properties: { type: { type: "string" } },
				additionalProperties: true,
			},
		},
	},
};
