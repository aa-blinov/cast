import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HooksFile,
	hookGroupId,
	hooksFileDiagnostics,
	listHooksForCwd,
	loadHooksForCwd,
	runHooksForEvent,
} from "../src/core/hooks.ts";

describe("loadHooksForCwd", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-hooks-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty config when no hooks.json exists anywhere", () => {
		expect(loadHooksForCwd(dir, true)).toEqual({});
	});

	it("reads a bare event-keyed file", () => {
		writeFileSync(
			join(dir, "hooks.json"),
			JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hi" }] }] }),
		);
		const hooks = loadHooksForCwd(dir, true, [{ path: join(dir, "hooks.json"), pluginRoot: dir }]);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
	});

	it("accepts the Claude-Code/Grok Build settings shape with a top-level hooks key", () => {
		writeFileSync(join(dir, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "true" }] }] } }));
		const hooks = loadHooksForCwd(dir, true, [{ path: join(dir, "hooks.json"), pluginRoot: dir }]);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("ignores an unrecognized event name instead of erroring (shared Claude/Cursor files)", () => {
		writeFileSync(
			join(dir, "hooks.json"),
			JSON.stringify({
				NotARealEvent: [{ hooks: [{ command: "true" }] }],
				Stop: [{ hooks: [{ command: "true" }] }],
			}),
		);
		const hooks = loadHooksForCwd(dir, true, [{ path: join(dir, "hooks.json"), pluginRoot: dir }]);
		expect(Object.keys(hooks)).toEqual(["Stop"]);
	});

	it("malformed JSON is treated as no hooks, not an error", () => {
		writeFileSync(join(dir, "hooks.json"), "{not json");
		const path = join(dir, "hooks.json");
		expect(() => loadHooksForCwd(dir, true, [{ path, pluginRoot: dir }])).not.toThrow();
		expect(loadHooksForCwd(dir, true, [{ path, pluginRoot: dir }])).toEqual({});
	});

	it("merges plugin-contributed hook files alongside global/project ones", () => {
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, JSON.stringify({ PreToolUse: [{ hooks: [{ command: "echo plugin" }] }] }));
		const hooks = loadHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }]);
		expect(hooks.PreToolUse).toHaveLength(1);
	});

	it("reads .cast/hooks.json under the cwd only when trusted", () => {
		mkdirSync(join(dir, ".cast"), { recursive: true });
		writeFileSync(join(dir, ".cast", "hooks.json"), JSON.stringify({ Stop: [{ hooks: [{ command: "true" }] }] }));
		expect(loadHooksForCwd(dir, false)).toEqual({});
		expect(loadHooksForCwd(dir, true).Stop).toHaveLength(1);
	});

	it("filters out disabled hook groups by id", () => {
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, JSON.stringify({ PreToolUse: [{ hooks: [{ command: "echo plugin" }] }] }));
		const all = loadHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }]);
		const id = hookGroupId("PreToolUse", all.PreToolUse![0]!);
		const filtered = loadHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }], new Set([id]));
		expect(filtered.PreToolUse).toBeUndefined();
	});
});

describe("listHooksForCwd", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-hooks-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists both enabled and disabled hooks with stable ids", () => {
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, JSON.stringify({ PreToolUse: [{ matcher: "bash", hooks: [{ command: "echo hi" }] }] }));
		const entries = listHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }]);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.source).toBe("plugin");
		expect(entries[0]?.enabled).toBe(true);

		const disabled = listHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }], new Set([entries[0]!.id]));
		expect(disabled[0]?.enabled).toBe(false);
	});

	it("hookGroupId is stable across repeated resolves of unchanged content", () => {
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, JSON.stringify({ Stop: [{ hooks: [{ command: "true" }] }] }));
		const a = listHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }]);
		const b = listHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir }]);
		expect(a[0]?.id).toBe(b[0]?.id);
	});

	it("REGRESSION: byte-identical hook content from different sources gets different ids (no cross-source collision)", () => {
		// Before the fix, hookGroupId hashed only event|matcher|hooks — two
		// groups with identical content from a project file and a plugin file
		// collided onto the same id, so disabling one via Settings silently
		// disabled the other too.
		const identical = JSON.stringify({ Stop: [{ hooks: [{ command: "true" }] }] });
		mkdirSync(join(dir, ".cast"), { recursive: true });
		writeFileSync(join(dir, ".cast", "hooks.json"), identical);
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, identical);

		const entries = listHooksForCwd(dir, true, [{ path: pluginFile, pluginRoot: dir, pluginId: "some-plugin" }]);
		const projectEntry = entries.find((e) => e.source === "project");
		const pluginEntry = entries.find((e) => e.source === "plugin");
		expect(projectEntry).toBeTruthy();
		expect(pluginEntry).toBeTruthy();
		expect(projectEntry!.id).not.toBe(pluginEntry!.id);
	});

	it("REGRESSION: hooksFileDiagnostics surfaces a malformed hooks.json instead of the silent empty-config fallback", () => {
		mkdirSync(join(dir, ".cast"), { recursive: true });
		writeFileSync(join(dir, ".cast", "hooks.json"), "{not valid json");
		const diagnostics = hooksFileDiagnostics(dir, true, []);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.path).toBe(join(dir, ".cast", "hooks.json"));
		expect(diagnostics[0]!.message).toBeTruthy();
	});

	it("hooksFileDiagnostics reports nothing for valid hooks.json files", () => {
		mkdirSync(join(dir, ".cast"), { recursive: true });
		writeFileSync(join(dir, ".cast", "hooks.json"), JSON.stringify({ Stop: [{ hooks: [{ command: "true" }] }] }));
		expect(hooksFileDiagnostics(dir, true, [])).toEqual([]);
	});

	it("hooksFileDiagnostics also checks plugin-contributed hook files", () => {
		const pluginFile = join(dir, "plugin-hooks.json");
		writeFileSync(pluginFile, "not json at all");
		const diagnostics = hooksFileDiagnostics(dir, true, [
			{ path: pluginFile, pluginRoot: dir, pluginId: "broken-plugin" },
		]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.path).toBe(pluginFile);
	});
});

describe("runHooksForEvent", () => {
	it("returns not-blocked when no hooks are registered for the event", async () => {
		const result = await runHooksForEvent({}, { event: "PreToolUse", matchTarget: "bash", cwd: "/tmp", payload: {} });
		expect(result.blocked).toBe(false);
	});

	it("skips a group whose matcher doesn't match the match target", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "^write$", hooks: [{ command: "exit 2" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(false);
	});

	it("blocks when a matching hook exits 2, surfacing stderr as the reason", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "bash", hooks: [{ command: "echo nope 1>&2; exit 2" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("nope");
	});

	it('blocks via JSON {"decision":"block"} on stdout even with exit 0', async () => {
		const hooks: HooksFile = {
			PostToolUse: [{ hooks: [{ command: 'echo \'{"decision":"block","reason":"formatting failed"}\'' }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PostToolUse",
			matchTarget: "write",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("formatting failed");
	});

	it("treats hookSpecificOutput.additionalContext as non-blocking context, not a block", async () => {
		const hooks: HooksFile = {
			Stop: [
				{ hooks: [{ command: 'echo \'{"hookSpecificOutput":{"additionalContext":"run the linter first"}}\'' }] },
			],
		};
		const result = await runHooksForEvent(hooks, { event: "Stop", cwd: "/tmp", payload: {} });
		expect(result.blocked).toBe(false);
		expect(result.additionalContext).toBe("run the linter first");
	});

	it('{"continue":false} force-stops regardless of any block', async () => {
		const hooks: HooksFile = {
			Stop: [{ hooks: [{ command: 'echo \'{"continue":false,"stopReason":"budget exhausted"}\'' }] }],
		};
		const result = await runHooksForEvent(hooks, { event: "Stop", cwd: "/tmp", payload: {} });
		expect(result.forceStop).toBe(true);
		expect(result.reason).toBe("budget exhausted");
	});

	it("a forceStop from one hook still merges additionalContext/updatedInput from sibling hooks in the same run", async () => {
		// Regression: the aggregation loop used to `return result` the instant
		// it saw forceStop, skipping the same merge the blocked-path gets —
		// silently dropping whatever other hooks in the batch had already set,
		// depending on array order.
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{ command: 'echo \'{"hookSpecificOutput":{"updatedInput":{"foo":"bar"}}}\'' },
						{ command: 'echo \'{"hookSpecificOutput":{"additionalContext":"context from sibling"}}\'' },
						{ command: 'echo \'{"continue":false,"stopReason":"stop from third hook"}\'' },
					],
				},
			],
		};
		const result = await runHooksForEvent(hooks, { event: "PreToolUse", cwd: "/tmp", payload: {} });
		expect(result.forceStop).toBe(true);
		expect(result.reason).toBe("stop from third hook");
		expect(result.updatedInput).toEqual({ foo: "bar" });
		expect(result.additionalContext).toBe("context from sibling");
	});

	it("a non-blocking failure (plain non-zero, non-2 exit) doesn't block", async () => {
		const hooks: HooksFile = { Stop: [{ hooks: [{ command: "exit 1" }] }] };
		const result = await runHooksForEvent(hooks, { event: "Stop", cwd: "/tmp", payload: {} });
		expect(result.blocked).toBe(false);
	});

	it("receives the payload (plus hook_event_name/cwd/session_id) as JSON on stdin", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ command: 'read line; echo "$line" 1>&2; exit 2' }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			sessionId: "sess-1",
			payload: { tool_name: "bash", tool_input: { command: "ls" } },
		});
		expect(result.blocked).toBe(true);
		const parsed = JSON.parse(result.reason!);
		expect(parsed.tool_name).toBe("bash");
		expect(parsed.tool_input.command).toBe("ls");
		expect(parsed.session_id).toBe("sess-1");
		expect(parsed.hook_event_name).toBe("PreToolUse");
	});

	it("injects CAST_* env vars into a command hook, including plugin vars", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{
							command:
								'printf \'%s|%s|%s\' "$CAST_HOOK_EVENT" "$CAST_SESSION_ID" "$CAST_WORKSPACE_ROOT" 1>&2; exit 2',
						},
					],
					_source: "global",
				},
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: tmpdir(),
			sessionId: "sess-2",
			payload: {},
		});
		expect(result.reason).toBe(`PreToolUse|sess-2|${tmpdir()}`);
	});

	it("strips a user-supplied reserved env key rather than letting it override the real value", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{
							command: 'echo "$CAST_HOOK_EVENT" 1>&2; exit 2',
							env: { CAST_HOOK_EVENT: "tampered" },
						},
					],
				},
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.reason).toBe("PreToolUse");
	});

	it("times out a hanging command hook", async () => {
		const hooks: HooksFile = { PreToolUse: [{ hooks: [{ command: "sleep 30", timeout: 1 }] }] };
		const start = Date.now();
		await runHooksForEvent(hooks, { event: "PreToolUse", matchTarget: "bash", cwd: "/tmp", payload: {} });
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("posts the event envelope to an HTTP hook and honors its decision", async () => {
		const server: Server = await new Promise((resolve) => {
			const srv = createServer((req, res) => {
				let body = "";
				req.on("data", (c: Buffer) => {
					body += c.toString();
				});
				req.on("end", () => {
					const parsed = JSON.parse(body);
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							decision: parsed.tool_name === "bash" ? "block" : undefined,
							reason: "http said no",
						}),
					);
				});
			});
			srv.listen(0, () => resolve(srv));
		});
		const port = (server.address() as AddressInfo).port;
		try {
			const hooks: HooksFile = {
				PreToolUse: [{ hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook`, timeout: 5 }] }],
			};
			const result = await runHooksForEvent(hooks, {
				event: "PreToolUse",
				matchTarget: "bash",
				cwd: "/tmp",
				payload: { tool_name: "bash" },
			});
			expect(result.blocked).toBe(true);
			expect(result.reason).toBe("http said no");
		} finally {
			server.close();
		}
	});

	it("fails open when an HTTP hook is unreachable", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1", timeout: 2 }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(false);
	});

	it("runs PostToolUseFailure/SubagentStart/SubagentStop/StopFailure/PreCompact/PostCompact/SessionStart/SessionEnd/UserPromptSubmit as ordinary events", async () => {
		for (const event of [
			"PostToolUseFailure",
			"SubagentStart",
			"SubagentStop",
			"StopFailure",
			"PreCompact",
			"PostCompact",
			"SessionStart",
			"SessionEnd",
			"UserPromptSubmit",
		] as const) {
			const hooks: HooksFile = { [event]: [{ hooks: [{ command: "exit 2" }] }] };
			const result = await runHooksForEvent(hooks, { event, cwd: "/tmp", payload: {} });
			expect(result.blocked).toBe(true);
		}
	});

	it("runs the newly added events (PostToolBatch, TaskCreated/Completed, InstructionsLoaded, CwdChanged-shaped, PermissionRequest/Denied, UserPromptExpansion) as ordinary events", async () => {
		for (const event of [
			"PostToolBatch",
			"TaskCreated",
			"TaskCompleted",
			"InstructionsLoaded",
			"PermissionRequest",
			"PermissionDenied",
			"UserPromptExpansion",
		] as const) {
			const hooks: HooksFile = { [event]: [{ hooks: [{ command: "exit 2" }] }] };
			const result = await runHooksForEvent(hooks, { event, cwd: "/tmp", payload: {} });
			expect(result.blocked).toBe(true);
		}
	});

	it("runs the Claude-Code-parity events (Notification, Setup, TeammateIdle, etc.) as ordinary events", async () => {
		for (const event of [
			"Notification",
			"Setup",
			"TeammateIdle",
			"Elicitation",
			"ElicitationResult",
			"ConfigChange",
			"WorktreeCreate",
			"WorktreeRemove",
			"FileChanged",
		] as const) {
			const hooks: HooksFile = { [event]: [{ hooks: [{ command: "exit 2" }] }] };
			const result = await runHooksForEvent(hooks, { event, cwd: "/tmp", payload: {} });
			expect(result.blocked).toBe(true);
		}
	});

	it("pipe-separated matchers match any listed tool name", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "Bash|Write|Edit", hooks: [{ command: "exit 2" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "Write",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
	});

	it("auto-detects match target from the payload's tool_name field", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "^Write$", hooks: [{ command: "exit 2" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: { tool_name: "Write" },
		});
		expect(result.blocked).toBe(true);
	});

	it("runs all hooks in parallel — a later hook still fires even after an earlier one blocks", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [{ command: "exit 2" }, { command: "true" }],
				},
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
	});

	it("deduplicates identical hooks within the same source context (pluginRoot)", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{ command: "echo hi && exit 2" },
						{ command: "echo hi && exit 2" }, // duplicate — should be dropped
					],
				},
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("hi");
	});

	it("does NOT deduplicate hooks with different pluginRoots (different source contexts)", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{ hooks: [{ command: "echo a && exit 2" }], _pluginRoot: "/p1" },
				{ hooks: [{ command: "echo a && exit 2" }], _pluginRoot: "/p2" },
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
		// Both ran — the first block wins, but the second one still produced
	});

	it("filter-out hook with unmet if condition (tool name mismatch)", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "bash", hooks: [{ command: "exit 2", if: "Write" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: { tool_name: "bash" },
		});
		expect(result.blocked).toBe(false);
	});

	it("keeps hook with matching if condition", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "bash", hooks: [{ command: "exit 2", if: "Bash" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: { tool_name: "Bash" },
		});
		expect(result.blocked).toBe(true);
	});

	it("keeps hook with matching if condition including a pattern", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "bash", hooks: [{ command: "exit 2", if: "Bash(git *)" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: { tool_name: "Bash", tool_input: { command: "git status" } },
		});
		expect(result.blocked).toBe(true);
	});

	it("drops hook with mismatched if condition pattern", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ matcher: "bash", hooks: [{ command: "exit 2", if: "Bash(git *)" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: { tool_name: "Bash", tool_input: { command: "npm run test" } },
		});
		expect(result.blocked).toBe(false);
	});

	it("skips hooks with if condition on non-tool events (matching Claude Code behavior)", async () => {
		const hooks: HooksFile = {
			SessionStart: [{ hooks: [{ command: "exit 2", if: "Bash(git *)" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "SessionStart",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(false);
	});

	it("PreToolUse permissionDecision:deny blocks with permissionDecisionReason as the reason", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{
							command:
								'echo \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"dangerous"}}\'',
						},
					],
				},
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("dangerous");
		expect(result.permissionDecision).toBe("deny");
	});

	it("PreToolUse permissionDecision:ask/defer surface the decision without blocking", async () => {
		for (const decision of ["ask", "defer"] as const) {
			const hooks: HooksFile = {
				PreToolUse: [
					{ hooks: [{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"${decision}"}}'` }] },
				],
			};
			const result = await runHooksForEvent(hooks, {
				event: "PreToolUse",
				matchTarget: "bash",
				cwd: "/tmp",
				payload: {},
			});
			expect(result.blocked).toBe(false);
			expect(result.permissionDecision).toBe(decision);
		}
	});

	it("PreToolUse updatedInput carries through even when the hook also allows", async () => {
		const hooks: HooksFile = {
			PreToolUse: [
				{ hooks: [{ command: 'echo \'{"hookSpecificOutput":{"updatedInput":{"command":"echo safe"}}}\'' }] },
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(false);
		expect(result.updatedInput).toEqual({ command: "echo safe" });
	});

	it("PostToolUse updatedToolOutput is returned for the caller to swap in", async () => {
		const hooks: HooksFile = {
			PostToolUse: [{ hooks: [{ command: 'echo \'{"hookSpecificOutput":{"updatedToolOutput":"redacted"}}\'' }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PostToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.updatedToolOutput).toBe("redacted");
	});

	it("mcp_tool hook calls the resolved MCP tool handle with interpolated input and interprets its result", async () => {
		const calls: Array<{ args: unknown }> = [];
		const mcpToolIndex = new Map([
			[
				"mcp_guard_check",
				{
					call: async (args: Record<string, unknown>) => {
						calls.push({ args });
						return { content: '{"decision":"block","reason":"guard says no"}' };
					},
				},
			],
		]) as unknown as Map<string, import("../src/core/mcp.ts").McpToolHandle>;
		const hooks: HooksFile = {
			PreToolUse: [
				// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder for cast's own ${...} interpolation, not a JS template
				{ hooks: [{ type: "mcp_tool", server: "guard", tool: "check", input: { cmd: "${tool_input.command}" } }] },
			],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: { tool_input: { command: "rm -rf /" } },
			mcpToolIndex,
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("guard says no");
		expect(calls[0]?.args).toEqual({ cmd: "rm -rf /" });
	});

	it("mcp_tool hook no-ops (fails open) when no mcpToolIndex is provided", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "guard", tool: "check" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(result.blocked).toBe(false);
	});

	it("prompt hook no-ops (fails open) when no config is provided", async () => {
		const hooks: HooksFile = {
			Stop: [{ hooks: [{ type: "prompt", prompt: "Should the agent keep going? Respond yes/no." }] }],
		};
		const result = await runHooksForEvent(hooks, { event: "Stop", cwd: "/tmp", payload: {} });
		expect(result.blocked).toBe(false);
	});

	it('backgrounds an async hook that prints {"async":true} on the first stdout line', async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ command: "echo '{\"async\":true}'; sleep 30; echo done", timeout: 2 }] }],
		};
		const start = Date.now();
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			matchTarget: "bash",
			cwd: "/tmp",
			payload: {},
		});
		expect(Date.now() - start).toBeLessThan(1000);
		expect(result.blocked).toBe(false);
	});

	it("HTTP hook sends custom headers with env var interpolation", async () => {
		const server: Server = await new Promise((resolve) => {
			const srv = createServer((req, res) => {
				let _body = "";
				req.on("data", (c: Buffer) => {
					_body += c.toString();
				});
				req.on("end", () => {
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							auth: req.headers.authorization,
							custom: req.headers["x-custom"],
						}),
					);
				});
			});
			srv.listen(0, () => resolve(srv));
		});
		const port = (server.address() as AddressInfo).port;
		const testToken = "test-token-123";
		process.env.__HOOK_TEST_TOKEN = testToken;
		try {
			const hooks: HooksFile = {
				PreToolUse: [
					{
						hooks: [
							{
								type: "http",
								url: `http://127.0.0.1:${port}/hook`,
								timeout: 5,
								headers: {
									// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for cast's own env-var interpolation, not JS template
									authorization: "Bearer ${__HOOK_TEST_TOKEN}",
									"x-custom": "static-value",
								},
								allowedEnvVars: ["__HOOK_TEST_TOKEN"],
							},
						],
					},
				],
			};
			const result = await runHooksForEvent(hooks, {
				event: "PreToolUse",
				matchTarget: "bash",
				cwd: "/tmp",
				payload: {},
			});
			const parsed = JSON.parse(result.stdout);
			expect(parsed.auth).toBe(`Bearer ${testToken}`);
			expect(parsed.custom).toBe("static-value");
		} finally {
			delete process.env.__HOOK_TEST_TOKEN;
			server.close();
		}
	});

	it("HTTP hook strips newlines from header values to prevent injection", async () => {
		const server: Server = await new Promise((resolve) => {
			const srv = createServer((req, res) => {
				let _body = "";
				req.on("data", (c: Buffer) => {
					_body += c.toString();
				});
				req.on("end", () => {
					res.setHeader("content-type", "application/json");
					const injected = req.headers["x-test"];
					res.end(JSON.stringify({ injected }));
				});
			});
			srv.listen(0, () => resolve(srv));
		});
		const port = (server.address() as AddressInfo).port;
		try {
			const hooks: HooksFile = {
				PreToolUse: [
					{
						hooks: [
							{
								type: "http",
								url: `http://127.0.0.1:${port}/hook`,
								timeout: 5,
								headers: { "x-test": "safe\r\nX-Injected: evil" },
							},
						],
					},
				],
			};
			const result = await runHooksForEvent(hooks, {
				event: "PreToolUse",
				cwd: "/tmp",
				payload: {},
			});
			const parsed = JSON.parse(result.stdout);
			expect(parsed.injected).toBe("safeX-Injected: evil");
		} finally {
			server.close();
		}
	});

	it("matches comma-separated names and file events by their basename", async () => {
		const hooks: HooksFile = {
			FileChanged: [{ matcher: "package.json, README.md", hooks: [{ command: "echo matched" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "FileChanged",
			cwd: "/tmp",
			payload: { file_name: "package.json" },
		});
		expect(result.stdout).toContain("matched");
	});

	it("runs PermissionDenied hooks with a matching if condition", async () => {
		const hooks: HooksFile = {
			PermissionDenied: [{ hooks: [{ if: "bash(git *)", command: "echo retry" }] }],
		};
		const result = await runHooksForEvent(hooks, {
			event: "PermissionDenied",
			cwd: "/tmp",
			payload: { tool_name: "bash", tool_input: { command: "git status" } },
		});
		expect(result.stdout).toContain("retry");
	});

	it("detaches a command explicitly marked async", async () => {
		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ command: "sleep 0.2", async: true, timeout: 2 }] }],
		};
		const start = Date.now();
		const result = await runHooksForEvent(hooks, {
			event: "PreToolUse",
			cwd: "/tmp",
			payload: {},
		});
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(result.blocked).toBe(false);
	});
});
