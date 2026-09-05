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
			/^\/api\/sessions\/[^/]+(\/(history|events|events\/history|image|diff|reasoning-options|fs|fs\/search|fs\/download|inputs|inputs\/download))?$/,
	},
	{ method: "DELETE", legacyPath: /^\/api\/sessions\/[^/]+(\/(permanent|share|fs|inputs))?$/ },
	{
		method: "POST",
		legacyPath:
			/^\/api\/sessions\/[^/]+\/(fork|chat|abort|steer|followup|command|mode|question|bash-confirm|plan-transition|clean-context|rename|pin|share|fs\/rename|inputs\/upload)$/,
	},
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
	"/api/v1/sessions/{id}/reasoning-options": {
		get: {
			summary: "List session reasoning options",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Reasoning options", { type: "object" }) },
		},
	},
	"/api/v1/sessions/{id}/fs": {
		get: {
			summary: "List session files",
			parameters: [idParameter],
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
			summary: "Search session files",
			parameters: [idParameter],
			responses: { "200": jsonResponse("Search results", { type: "object" }) },
		},
	},
	"/api/v1/sessions/{id}/fs/download": {
		get: {
			summary: "Download a session file",
			parameters: [idParameter],
			responses: {
				"200": {
					description: "File bytes",
					content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
				},
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
				responses: {
					"201": jsonResponse("Forked session", { $ref: "#/components/schemas/CreateSessionResponse" }),
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
			ChatRequest: {
				type: "object",
				properties: {
					text: { type: "string" },
					images: { type: "array", maxItems: 6, items: { type: "string", contentEncoding: "base64" } },
					clientMessageId: { type: "string", maxLength: 200 },
					goal: {
						description:
							"Run the turn as a goal: `true` for the default iteration budget, or a number (1-200) to set it.",
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
