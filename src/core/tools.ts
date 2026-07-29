import { readFileSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import type { Tool } from "./llm.ts";
import type { PlanState } from "./plan.ts";
import {
	checkPlanFileGate,
	enforcePlanCapAfterEdit,
	execPlanCheck,
	execPlanDiscard,
	execPlanDone,
	execPlanEnter,
	finalizePlanFileWrite,
	MAX_PLAN_CHARS,
	maybeActivatePlanOnRead,
} from "./plan.ts";
import { loadSettings } from "./settings.ts";
import type { SshHost } from "./ssh.ts";
import { execBash } from "./tools/bash.ts";
import { type BashBackgroundDeps, execBashKill, execBashOutput } from "./tools/bash-background.ts";
import { execEdit, execRead, execWrite } from "./tools/files.ts";
import { execGlob, execGrep, execLs } from "./tools/search.ts";
import { type ConfirmBash, resolvePath, type ToolExecutor, type ToolResult } from "./tools/shared.ts";
import { execSsh } from "./tools/ssh.ts";
import { execTask, type TaskExecutorDeps } from "./tools/task.ts";
import { execWebFetch, execWebSearch } from "./tools/web.ts";

export type { BashBackgroundDeps } from "./tools/bash-background.ts";
// Re-export the public tool types so existing importers of "./tools.ts"
// (loop.ts, mcp.ts, tests) keep working after the split into tools/*.
export type { ConfirmBash, ToolExecutor, ToolResult } from "./tools/shared.ts";
export type { TaskExecutorDeps } from "./tools/task.ts";

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

	return [
		{
			type: "function",
			function: {
				name: "bash",
				description:
					"Execute a bash command in the current working directory. Returns stdout and stderr. " +
					"Output is truncated to last 2000 lines or 128KB (whichever is hit first). " +
					"Default timeout 180s. For long-running commands (docker build, npm install, large test suites), " +
					"pass a higher timeout value. " +
					"Do NOT re-run an identical command to 'double-check' a result you already have — the previous " +
					"output still holds unless something changed. Running the same command repeatedly is treated as a " +
					"doom loop and blocked.",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string", description: "Bash command to execute" },
						timeout: {
							type: "number",
							description:
								"Timeout in seconds. Default 180. Increase for long-running commands (e.g. 600 for docker build)",
						},
						...(backgroundBashEnabled
							? {
									run_in_background: {
										type: "boolean",
										description:
											"Run this command in the background and return immediately with a task id, instead of " +
											"waiting for it to finish. Use for commands you don't need to block on: dev servers, " +
											"long builds/tests you'll check on later, anything open-ended. You don't need to poll — " +
											"a <system-reminder> arrives automatically with the output when it finishes, even if you've " +
											"moved on to something else. Check bash_output only if you want progress sooner, or " +
											"bash_kill to stop it early.",
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
								"Check on a background bash task started with bash's run_in_background:true. Returns its " +
								"current status (running/exited/killed) and captured output so far. You don't need this to " +
								"find out when a task finishes — a <system-reminder> arrives automatically — only call it if " +
								"you want progress sooner. Repeated identical calls on the same task_id are expected while " +
								"waiting and are never treated as a doom loop.",
							parameters: {
								type: "object",
								properties: {
									task_id: {
										type: "string",
										description: "Task id returned by bash's run_in_background:true",
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
								"Terminate a running background bash task started with bash's run_in_background:true.",
							parameters: {
								type: "object",
								properties: {
									task_id: {
										type: "string",
										description: "Task id returned by bash's run_in_background:true",
									},
								},
								required: ["task_id"],
							},
						},
					},
				]
			: []),
		// Plan mode tools — always defined, filtered via disabledTools when not in
		// plan mode, so the model only ever sees them while /plan is active (no
		// "only available in plan mode" boilerplate needed in the descriptions).
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
				name: "plan_discard",
				description:
					"Delete a plan from this session (e.g. an abandoned draft the user asked to drop). " +
					"If it was the active plan, the newest remaining one becomes active.",
				parameters: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Name of the plan to discard",
						},
					},
					required: ["name"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_enter",
				description:
					"Suggest switching to plan mode when the user's request is complex enough to benefit from planning " +
					"before implementation (multiple files, architectural decisions, unclear scope). The user is asked to " +
					"confirm — call this, then END YOUR TURN and wait. Do not call it for simple, direct tasks.",
				parameters: {
					type: "object",
					properties: {
						reason: {
							type: "string",
							description: "One sentence on why this task benefits from planning first",
						},
					},
					required: ["reason"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "plan_check",
				description:
					"Mark a checklist item in the approved plan as done ('- [ ]' → '- [x]'). " +
					"Call it right after completing each plan step. Matching is forgiving — a short paraphrase " +
					"in your own words is fine, no need to copy the plan's exact wording or markdown formatting " +
					"(`**bold**`, `` `code` ``); no need to re-read the plan first just to get the item text exact.",
				parameters: {
					type: "object",
					properties: {
						item: {
							type: "string",
							description:
								"The step, in your own words — case-insensitive, markdown-decoration-insensitive; exact match wins over substring",
						},
						plan: {
							type: "string",
							description: "Plan name to check the item off in (omit for the active plan)",
						},
						index: {
							type: "number",
							description: "1-based pick when several items match the same text (from the ambiguity error)",
						},
					},
					required: ["item"],
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
								"Create/update the task list for this session. Pass the FULL list every call, not just " +
								"changed items — this is a full rewrite, not a patch. Use for any task with 3+ distinct " +
								"steps, multiple user-provided items, or work that benefits from planning; skip it for a " +
								"single straightforward task. Exactly one item may be in_progress at a time. Mark an item " +
								"completed the moment the work (including any required verification) is actually done — " +
								"never batched, never based on intent. Never mark something completed to look efficient " +
								"or to move on faster — an item falsely marked done is worse than one honestly left pending.",
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
): ToolExecutor {
	return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
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
					if (planState?.enabled) {
						const absolutePath = resolvePath(String(args.path ?? ""), cwd);
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
						const result = await execWrite(args, cwd);
						if (!result.isError) finalizePlanFileWrite(absolutePath, planState);
						return result;
					}
					return await execWrite(args, cwd);
				}
				case "edit": {
					if (planState?.enabled) {
						const absolutePath = resolvePath(String(args.filePath ?? ""), cwd);
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
						const result = await execEdit(args, cwd, config);
						if (!result.isError) {
							const capResult = enforcePlanCapAfterEdit(absolutePath, beforeContent);
							if (!capResult.ok) return { content: capResult.error, isError: true };
							finalizePlanFileWrite(absolutePath, planState);
						}
						return result;
					}
					return await execEdit(args, cwd, config);
				}
				case "glob":
				case "find": // legacy alias — same implementation as glob
					return await execGlob(args, cwd, config);
				case "grep":
					return await execGrep(args, cwd, config);
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
					return await execTask(args, cwd, config, taskDeps, signal);
				case "plan_done":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanDone(args, planState);
				case "plan_check":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanCheck(args, planState);
				case "plan_enter":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanEnter(args, planState);
				case "plan_discard":
					if (!planState) return { content: "Plan tool not available.", isError: true };
					return execPlanDiscard(args, planState);
				default:
					return { content: `Unknown tool: ${name}`, isError: true };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { content: message, isError: true };
		}
	};
}
