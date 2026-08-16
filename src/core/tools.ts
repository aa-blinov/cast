import { readFileSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import type { Tool } from "./llm.ts";
import { execMemorySearch, MEMORY_TOOL_DESCRIPTION } from "./memory.ts";
import type { PlanState } from "./plan.ts";
import {
	checkPlanFileGate,
	enforcePlanCapAfterEdit,
	execPlanDone,
	execQuestion,
	finalizePlanFileWrite,
	MAX_PLAN_CHARS,
	maybeActivatePlanOnRead,
} from "./plan.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";
import { execSessionHistorySearch, SESSION_HISTORY_TOOL_DESCRIPTION } from "./session-query.ts";
import { loadSettings } from "./settings.ts";
import type { SshHost } from "./ssh.ts";
import { execBash } from "./tools/bash.ts";
import { type BashBackgroundDeps, execBashKill, execBashOutput } from "./tools/bash-background.ts";
import { execEdit, execRead, execWrite } from "./tools/files.ts";
import { execGlob, execGrep, execLs } from "./tools/search.ts";
import {
	type ConfirmBash,
	normalizeToolResultError,
	resolvePath,
	type ToolExecutor,
	type ToolResult,
	toolError,
} from "./tools/shared.ts";
import { execSkill, type SkillToolDeps } from "./tools/skill.ts";
import { execSsh } from "./tools/ssh.ts";
import { execTask, type TaskExecutorDeps } from "./tools/task.ts";
import { execWebFetch, execWebSearch } from "./tools/web.ts";

export type { BashBackgroundDeps } from "./tools/bash-background.ts";
// Re-export the public tool types so existing importers of "./tools.ts"
// (loop.ts, mcp.ts, tests) keep working after the split into tools/*.
export type { ConfirmBash, ConfirmWrite, ToolExecutor, ToolResult } from "./tools/shared.ts";
export type { TaskExecutorDeps } from "./tools/task.ts";

const MEMORY_DESCRIPTION = `${readRequiredPrompt(promptsDir, "memory-tool.md").trim()}\n\n${MEMORY_TOOL_DESCRIPTION}`;
const SESSION_HISTORY_DESCRIPTION = `${readRequiredPrompt(promptsDir, "session-history-tool.md").trim()}\n\n${SESSION_HISTORY_TOOL_DESCRIPTION}`;

// ============================================================================
// Tool definitions (OpenAI function calling format)
// ============================================================================

export function getToolDefinitions(
	personaNames?: string[],
	mainModel?: string,
	subagentModel?: string,
	sshHostNames?: string[],
	backgroundBashEnabled?: boolean,
	includeTodoTool?: boolean,
	includeSkillTool = true,
	memoryEnabled = true,
): Tool[] {
	const personaList =
		personaNames && personaNames.length > 0
			? `Available subagents: ${personaNames.join(", ")}. Defaults to "${personaNames.includes("worker") ? "worker" : personaNames[0]}" if omitted.`
			: "";
	const modelInfo = subagentModel && subagentModel !== mainModel ? ` Subagent model: ${subagentModel}.` : "";
	// Read fresh each call (this function runs once per turn) so a
	// /web-search-provider switch changes what's advertised on the very next
	// turn, same as execWebSearch's own fresh read of the same setting.
	const searchProviderName = loadSettings().searchProvider ?? "ddg";
	const memoryTool: Tool = {
		type: "function",
		function: {
			name: "memory",
			description: MEMORY_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					operation: { type: "string", enum: ["search"], description: "Memory operation" },
					query: { type: "string", description: "One to three distinctive search terms" },
					limit: { type: "number", description: "Maximum results, default 8" },
					scope: {
						type: "string",
						enum: ["global", "projects", "sessions", "cc"],
						description:
							"Optional memory scope; projects is the current project, sessions narrows to one session.",
					},
					scope_id: { type: "string", description: "Optional project id or session id for the selected scope." },
					type: { type: "string", description: "Optional memory entry type such as rule, fix, or architecture." },
				},
				required: ["query"],
			},
		},
	};

	return [
		{
			type: "function",
			function: {
				name: "bash",
				description:
					"Execute a bash command in the current working directory. Returns stdout and stderr. " +
					"Output is truncated to last 2000 lines or 128KB (whichever is hit first). " +
					"Short commands return normally. Long-running commands are automatically promoted to a managed background task " +
					"instead of blocking indefinitely; use run_in_background:true to start one immediately. " +
					"Background results arrive automatically, and bash_output/bash_kill can inspect or stop them. " +
					"Do NOT re-run an identical command to 'double-check' a result you already have — the previous " +
					"output still holds unless something changed. Running the same command repeatedly is treated as a " +
					"doom loop and blocked.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Bash command to execute" },
						timeout: {
							type: "number",
							description: backgroundBashEnabled
								? "Timeout in seconds. A foreground command that outlives its grace period is promoted to background rather than killed. " +
									"With run_in_background:true, this is the task's kill timeout; omit it for an open-ended server or watcher."
								: "Timeout in seconds. Default 180. Increase for long-running commands (e.g. 600 for docker build)",
						},
						...(backgroundBashEnabled
							? {
									run_in_background: {
										type: "boolean",
										description:
											"Start a managed background task and return its task id immediately. Use for dev servers, watchers, " +
											"or long work whose result is not needed before the next action. " +
											"The result is delivered automatically when it finishes; use bash_output({task_id,wait}) for progress " +
											"or bash_kill({task_id}) to stop it. If omitted, long-running commands may be promoted automatically.",
									},
								}
							: {}),
					},
					required: ["command"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "session_history",
				description: SESSION_HISTORY_DESCRIPTION,
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "One to three distinctive search terms" },
						limit: { type: "number", description: "Maximum results, default 10" },
						scope: {
							type: "string",
							enum: ["project", "global"],
							description:
								'"project" (default) searches only sessions in the current working directory; "global" searches across every project — use it for "when did we fix/decide X" across all your history.',
						},
					},
					required: ["query"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read",
				description:
					"Read the contents of a file. When you already know the path, call this directly — do not search with glob/ls first. " +
					"Supports text files and images (jpg, jpeg, png, gif, webp, bmp — " +
					"shown to you as an image in the next message; only works if the model supports vision). " +
					"Output is truncated to 2000 lines or 128KB. Use offset/limit for large files. " +
					"Large images are automatically downscaled to fit; only rejected if truly huge (25MB+). " +
					"Each line is prefixed with its line number (`N: content`) — use the exact text (not the number) when calling `edit`. " +
					"You already have the contents of every file you read earlier in this session — do NOT read the " +
					"same path again unless it has changed since (e.g. you just edited it); re-use the earlier result " +
					"instead. Reading the same unchanged file repeatedly is treated as a doom loop and blocked.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to read (relative or absolute)" },
						offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
						limit: { type: "number", description: "Maximum number of lines to read" },
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write",
				description:
					"Create a new file or overwrite an entire file. Prefer `edit` for surgical changes to existing files. " +
					"Do NOT fall back to write because an edit failed — retry the edit with more surrounding context in oldString instead; " +
					"a from-memory rewrite tends to reproduce stale content. " +
					"Automatically creates parent directories.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path to the file to write (relative or absolute)" },
						content: { type: "string", description: "Content to write to the file" },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "edit",
				description:
					"Performs exact string replacement in a file. You must read the file (or already have its contents from this " +
					"session) before editing it. " +
					"`oldString` must be the exact literal text to replace, including all whitespace and indentation — copy it " +
					"verbatim from a recent `read`, don't retype it from memory. Include enough surrounding context (a few lines) " +
					"to make `oldString` uniquely match one location in the file, or the edit is rejected as ambiguous. " +
					"By default only the first occurrence is checked and it must be unique; set `replaceAll` to replace every " +
					'occurrence instead. Use `oldString: ""` on a path that doesn\'t exist yet to create a new file with ' +
					"`newString` as its content (prefer `write` for that, but this works too). " +
					"If the edit fails because the text wasn't found or matched more than once, re-read the file and retry with " +
					"the exact current text and more context — never give up and rewrite the whole file with `write`.",
				parameters: {
					type: "object",
					properties: {
						filePath: { type: "string", description: "Path to the file to edit (relative or absolute)" },
						oldString: {
							type: "string",
							description:
								"The exact literal text to replace, copied verbatim (including whitespace/indentation) from a recent read. Empty string creates a new file.",
						},
						newString: {
							type: "string",
							description: "The text to replace it with. Must differ from oldString.",
						},
						replaceAll: {
							type: "boolean",
							description:
								"Replace all occurrences of oldString instead of requiring exactly one match (default: false).",
						},
					},
					required: ["filePath", "oldString", "newString"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "glob",
				description:
					"Search for files by glob pattern (e.g. '*.ts', '**/*.json', 'src/**/*.spec.ts'). " +
					"Only when the path is unknown. If the user already named a file (greet.ts, CHANGELOG.md, config, …), " +
					"call `read` on that name first — do not glob. One glob call is enough; then read a hit.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Glob pattern to match files" },
						path: { type: "string", description: "Directory to search in (default: current directory)" },
						limit: { type: "number", description: "Maximum number of results (default: 1000)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "grep",
				description:
					"Search file contents by regex pattern. Supports context lines, case-insensitive, literal mode.",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "Search pattern (regex or literal string)" },
						path: { type: "string", description: "Directory or file to search (default: current directory)" },
						glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
						ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
						literal: { type: "boolean", description: "Treat pattern as literal string (default: false)" },
						context: { type: "number", description: "Lines before/after each match (default: 0)" },
						limit: { type: "number", description: "Maximum number of matches (default: 100)" },
					},
					required: ["pattern"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "ls",
				description:
					"List directory contents (type, size, name). For locating a named file use `read` or `glob`, not ls.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Directory to list (default: current directory)" },
						limit: { type: "number", description: "Maximum number of entries (default: 500)" },
					},
				},
			},
		},
		...(memoryEnabled ? [memoryTool] : []),
		{
			type: "function",
			function: {
				name: "web_search",
				description:
					searchProviderName === "tavily"
						? "Search the web via Tavily. Returns titles, URLs, and snippets. " +
							"Good for finding current information, documentation, and answers to questions " +
							"that require up-to-date knowledge."
						: searchProviderName === "brave"
							? "Search the web via Brave Search. Returns titles, URLs, and snippets. " +
								"Good for finding current information, documentation, and answers to questions " +
								"that require up-to-date knowledge."
							: "Search the web via DuckDuckGo. Returns titles, URLs, and snippets. " +
								"No API key required. Good for finding current information, documentation, " +
								"and answers to questions that require up-to-date knowledge.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query" },
						maxResults: {
							type: "number",
							description: "Maximum number of results (default: 10)",
						},
						// region/time are DuckDuckGo-only — Tavily/Brave have no
						// equivalent filters exposed here, and silently ignoring them
						// if the model still sent them (e.g. leftover habit from a
						// DDG-era conversation) is better than advertising a knob that
						// does nothing on this backend.
						...(searchProviderName === "ddg"
							? {
									region: {
										type: "string",
										description: "Region code, e.g. 'us-en', 'ru-ru', 'wt-wt' (default: wt-wt)",
									},
									time: {
										type: "string",
										description: "Time filter: 'd' (day), 'w' (week), 'm' (month), 'y' (year)",
									},
								}
							: {}),
					},
					required: ["query"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "web_fetch",
				description:
					"Fetch a web page and return its content as markdown, plain text, or raw HTML. " +
					"Backend is configurable via /web-fetch-provider: Jina Reader (default, handles JS " +
					"rendering and PDFs) or a local direct fetch (no third party sees the URL). " +
					"Useful for reading articles, documentation, and any web content.",
				parameters: {
					type: "object",
					properties: {
						url: { type: "string", description: "URL to fetch" },
						maxChars: {
							type: "number",
							description: "Maximum characters to return (default: 12000)",
						},
						format: {
							type: "string",
							enum: ["markdown", "text", "html"],
							description:
								"Output format (default: markdown). Only affects the 'local' backend — " +
								"Jina Reader always returns markdown.",
						},
					},
					required: ["url"],
				},
			},
		},
		...(personaNames?.length
			? [
					{
						type: "function" as const,
						function: {
							name: "task",
							description:
								"Start a subagent that works on a task independently and reports back. " +
								"Child tool calls stay out of your context — only the final result is returned. " +
								"When the user asks for parallel/independent/concurrent work across separate areas, " +
								"emit multiple task calls in the same turn (one assignment per area) instead of doing all the reads yourself. " +
								`Also use for isolated research, review, or exploration. ${personaList}${modelInfo}`,
							parameters: {
								type: "object",
								properties: {
									assignment: {
										type: "string",
										description: "Complete, self-contained task description for the subagent",
									},
									subagent: {
										type: "string",
										description:
											"Subagent name (optional). Prefer 'explore' for read-only mapping, 'review' for independent validation; 'worker' (default) for everything else — edits, mixed work, or unclear fit.",
									},
								},
								required: ["assignment"],
							},
						},
					},
				]
			: []),
		// SSH tool — only when hosts are configured
		...(sshHostNames?.length
			? [
					{
						type: "function" as const,
						function: {
							name: "ssh",
							description:
								"Execute one command on a remote host via SSH. Hosts are configured in\n" +
								"~/.cast/ssh.json (global) or .cast/ssh.json (project). Returns combined\nstdout+stderr. Use for remote server management, deployment, debugging.\n\nAvailable hosts:\n" +
								sshHostNames.map((n) => `- ${n}`).join("\n"),
							parameters: {
								type: "object",
								properties: {
									host: {
										type: "string",
										description: "Host name key from configured SSH hosts",
									},
									command: {
										type: "string",
										description: "Remote command to execute",
									},
									timeout: {
										type: "number",
										description: "Timeout in seconds. Default 180.",
									},
								},
								required: ["host", "command"],
							},
						},
					},
				]
			: []),
		// Background bash follow-ups — only when a session has background-task
		// support wired in (web/TUI; not `cast run`, not subagents — see
		// LoopConfig.backgroundBash's doc comment).
		...(backgroundBashEnabled
			? [
					{
						type: "function" as const,
						function: {
							name: "bash_output",
							description:
								"Check on a managed background bash task returned by bash, either through run_in_background:true " +
								"or automatic promotion. Returns its " +
								"current status (running/exited/killed) and captured output so far. You don't need this to " +
								"find out when a task finishes — a <system-reminder> arrives automatically — only call it if " +
								"you want progress sooner. Repeated identical calls on the same task_id are expected while " +
								"waiting and are never treated as a doom loop.",
							parameters: {
								type: "object",
								properties: {
									task_id: {
										type: "string",
										description: "Task id returned by bash for an explicit or automatically promoted task",
									},
									wait: {
										type: "number",
										description:
											"Optional: block up to this many seconds (max 60) for the task to finish before " +
											"returning, instead of returning the current status immediately.",
									},
								},
								required: ["task_id"],
							},
						},
					},
					{
						type: "function" as const,
						function: {
							name: "bash_kill",
							description:
								"Terminate a running managed background bash task returned by bash, either explicitly or through automatic promotion.",
							parameters: {
								type: "object",
								properties: {
									task_id: {
										type: "string",
										description: "Task id returned by bash for an explicit or automatically promoted task",
									},
								},
								required: ["task_id"],
							},
						},
					},
				]
			: []),
		// Plan mode tools are filtered via disabledTools when not in plan mode.
		// Authoring AND reading the plan itself use the ordinary write/edit/read
		// tools above, gated (write/edit) or side-effected (read) against the
		// active plan file's path — see plan.ts's file doc comment. Other plans
		// in the session are discoverable with ls/glob on the plans directory
		// named in the plan-mode system prompt block.
		{
			type: "function",
			function: {
				name: "plan_done",
				description: "Signal that the active plan is complete and ready for user review.",
				parameters: {
					type: "object",
					properties: {
						summary: {
							type: "string",
							description: "One-line summary of what the plan covers",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "question",
				description:
					"Ask the user one to five concrete questions when their decision is needed. This opens a picker and ends your turn. Each question needs 2–4 options; recommend one when appropriate.",
				parameters: {
					type: "object",
					properties: {
						questions: {
							type: "array",
							description: "One to five questions for the user",
							items: {
								type: "object",
								properties: {
									question: { type: "string", description: "The decision the user must make" },
									options: {
										type: "array",
										description: "Two to four choices for this question",
										items: {
											type: "object",
											properties: {
												value: { type: "string", description: "Stable machine-readable choice" },
												label: { type: "string", description: "Short user-facing choice" },
												description: { type: "string", description: "One-sentence tradeoff" },
											},
											required: ["value", "label"],
										},
									},
									recommended: { type: "string", description: "The value of the recommended option" },
								},
								required: ["question", "options"],
							},
						},
					},
					required: ["questions"],
				},
			},
		},
		...(includeTodoTool
			? [
					{
						type: "function" as const,
						function: {
							name: "todo_write",
							description:
								"Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.\n\n" +
								"## When to use\n" +
								"Use proactively when:\n" +
								"- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)\n" +
								"- The work is non-trivial and benefits from planning\n" +
								"- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list\n" +
								"- New instructions arrive — capture them as todos\n" +
								"- You start a task — mark it `in_progress` (only one at a time) before working\n" +
								"- You finish a task — mark it `completed` and add any follow-ups discovered during the work\n\n" +
								"## When NOT to use\n" +
								"Skip when:\n" +
								"- The work is a single, straightforward task (or <3 trivial steps)\n" +
								"- The request is purely informational or conversational\n" +
								"- Tracking adds no organizational value\n\n" +
								"## States\n" +
								"- `pending` — not started\n" +
								"- `in_progress` — actively working (exactly ONE at a time)\n" +
								"- `completed` — finished successfully\n" +
								"- `cancelled` — no longer needed\n\n" +
								"## Rules\n" +
								"- Update status in real time; don't batch completions\n" +
								"- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.\n" +
								"- Keep exactly one `in_progress` while work remains\n" +
								"- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker\n" +
								"- Pass the FULL list every call, not just changed items — this is a full rewrite, not a patch",
							parameters: {
								type: "object",
								properties: {
									todos: {
										type: "array",
										description: "The complete, updated todo list",
										items: {
											type: "object",
											properties: {
												content: {
													type: "string",
													description: "Brief, specific, actionable description of the task",
												},
												status: {
													type: "string",
													enum: ["pending", "in_progress", "completed", "cancelled"],
												},
												priority: { type: "string", enum: ["high", "medium", "low"] },
											},
											required: ["content", "status", "priority"],
										},
									},
								},
								required: ["todos"],
							},
						},
					},
				]
			: []),
		...(includeSkillTool
			? [
					{
						type: "function" as const,
						function: {
							name: "skill",
							description:
								"Load a specialized skill by name. Skills contain detailed workflows and instructions for specific tasks. Call this when the user's request matches a skill's description, or when they invoke /skill:name.",
							parameters: {
								type: "object",
								properties: {
									name: {
										type: "string",
										description: "The skill name to load (e.g. 'deep-research', 'arxiv', 'learn-everything')",
									},
									args: {
										type: "string",
										description:
											"Optional arguments to pass to the skill (replaces $ARGUMENTS in the skill body)",
									},
								},
								required: ["name"],
							},
						},
					},
				]
			: []),
	];
}

// ============================================================================
// Tool execution — dispatches a tool call to its implementation module.
// ============================================================================

export function createToolExecutor(
	cwd: string,
	config: AppConfig,
	confirmBash?: ConfirmBash,
	taskDeps?: TaskExecutorDeps,
	planState?: PlanState,
	sshHosts?: SshHost[],
	backgroundBash?: BashBackgroundDeps,
	skillDeps?: SkillToolDeps,
	beforeFileWrite?: (path: string) => void,
): ToolExecutor {
	return async (
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		toolCallId?: string,
	): Promise<ToolResult> => {
		const dispatch = async (): Promise<ToolResult> => {
			try {
				switch (name) {
					case "bash":
						return await execBash(args, cwd, config, confirmBash, signal, backgroundBash);
					case "bash_output":
						return await execBashOutput(args, config, backgroundBash, signal);
					case "bash_kill":
						return await execBashKill(args, backgroundBash);
					case "read": {
						const result = await execRead(args, cwd, config);
						// A read of the active-or-other plan file while plan mode is
						// active makes it the active plan — same effect plan_read's
						// `name` argument used to have, without a dedicated tool. Build
						// mode intentionally skips this: the approved plan must keep
						// steering via the mirror block regardless of what gets read.
						if (planState?.enabled && !result.isError) {
							const absolutePath = resolvePath(String(args.path ?? ""), cwd);
							maybeActivatePlanOnRead(absolutePath, planState);
						}
						return result;
					}
					case "write": {
						const absolutePath = resolvePath(String(args.path ?? ""), cwd);
						if (planState?.enabled) {
							const gate = checkPlanFileGate(absolutePath, planState);
							if (!gate.ok) return { content: gate.error, isError: true };
							// write's full content is known up front — enforce the size
							// cap before touching disk, same as the old plan_write.
							const content = typeof args.content === "string" ? args.content : "";
							if (content.length > MAX_PLAN_CHARS) {
								return {
									content: `Error: plan is ${content.length} chars — the limit is ${MAX_PLAN_CHARS}. A plan is an execution spec, not a document dump: cut decision-free prose, keep every step concrete.`,
									isError: true,
								};
							}
							beforeFileWrite?.(absolutePath);
							const result = await execWrite(args, cwd);
							if (!result.isError) finalizePlanFileWrite(absolutePath, planState);
							return result;
						}
						beforeFileWrite?.(absolutePath);
						return await execWrite(args, cwd);
					}
					case "edit": {
						const absolutePath = resolvePath(String(args.filePath ?? ""), cwd);
						if (planState?.enabled) {
							const gate = checkPlanFileGate(absolutePath, planState);
							if (!gate.ok) return { content: gate.error, isError: true };
							// Snapshot before the edit — ops apply as anchored deltas, so
							// the resulting size isn't known until after. If it lands over
							// the cap, enforcePlanCapAfterEdit rolls back to this content.
							let beforeContent = "";
							try {
								beforeContent = readFileSync(absolutePath, "utf-8");
							} catch {
								// No existing file to snapshot — execEdit itself will
								// surface the real "file not found" error below.
							}
							beforeFileWrite?.(absolutePath);
							const result = await execEdit(args, cwd, config);
							if (!result.isError) {
								const capResult = enforcePlanCapAfterEdit(absolutePath, beforeContent);
								if (!capResult.ok) return { content: capResult.error, isError: true };
								finalizePlanFileWrite(absolutePath, planState);
							}
							return result;
						}
						beforeFileWrite?.(absolutePath);
						return await execEdit(args, cwd, config);
					}
					case "glob":
					case "find": // legacy alias — same implementation as glob
						return await execGlob(args, cwd, config, signal);
					case "grep":
						return await execGrep(args, cwd, config, signal);
					case "memory":
						return execMemorySearch(args, cwd);
					case "session_history":
						return execSessionHistorySearch(args, cwd);
					case "ls":
						return await execLs(args, cwd, config);
					case "web_search":
						return await execWebSearch(args, signal);
					case "web_fetch":
						return await execWebFetch(args, signal);
					case "ssh":
						return await execSsh(args, sshHosts ?? [], config, confirmBash, signal);
					case "task":
						if (!taskDeps)
							return { content: "Task tool not available — no dependencies configured.", isError: true };
						return await execTask(args, cwd, config, taskDeps, signal, toolCallId);
					case "plan_done":
						if (!planState) return { content: "Plan tool not available.", isError: true };
						return execPlanDone(args, planState);
					case "question":
						if (!planState) return { content: "Question tool not available.", isError: true };
						return execQuestion(args, planState);
					case "skill":
						if (!skillDeps) return { content: "Skill tool not available.", isError: true };
						return execSkill(args, skillDeps);
					default:
						return { content: `Unknown tool: ${name}`, isError: true };
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return toolError(
					`Error: ${name} failed unexpectedly: ${message}. Check the tool arguments, path, and permissions, then retry.`,
					{
						code: "INTERNAL_ERROR",
						retryable: false,
						suggestedFix: "Check the tool arguments, path, and permissions, then retry.",
					},
				);
			}
		};
		return normalizeToolResultError(await dispatch());
	};
}
