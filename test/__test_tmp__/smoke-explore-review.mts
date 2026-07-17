/**
 * Live smoke: explore + review subagents via execTask (real LLM).
 * Disposable fixture under this dir. Does not print secrets.
 *
 *   npx tsx test/__test_tmp__/smoke-explore-review.mts
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../../src/core/config.ts";
import { runAgentLoop } from "../../src/core/loop.ts";
import { loadSubagentPrompts } from "../../src/core/subagents.ts";
import { execTask } from "../../src/core/tools/task.ts";

const FIXTURE = join(import.meta.dirname, "smoke-subagents-fixture");
const MUTATION_SENTINEL = join(FIXTURE, "MUST_NOT_EXIST.ts");

function loadConnection(): { baseURL: string; apiKey: string; model: string } {
	// Prefer saved CLI credentials — repo .env may be stale.
	const settingsPath = join(homedir(), ".cast/settings.json");
	if (existsSync(settingsPath)) {
		const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			providerUrl?: string;
			apiKey?: string;
			model?: string;
			subagentModel?: string;
			providers?: Array<{ url?: string; apiKey?: string }>;
		};
		const fromProviders = s.providers?.[0];
		const baseURL = s.providerUrl || fromProviders?.url || process.env.PROVIDER_BASE_URL;
		const apiKey = s.apiKey || fromProviders?.apiKey || process.env.PROVIDER_API_KEY;
		const model = s.subagentModel || s.model || "xiaomi/mimo-v2.5-pro";
		if (baseURL && apiKey) return { baseURL, apiKey, model };
	}
	const baseURL = process.env.PROVIDER_BASE_URL;
	const apiKey = process.env.PROVIDER_API_KEY;
	if (!baseURL || !apiKey) throw new Error("No provider credentials in ~/.cast/settings.json or env");
	return { baseURL, apiKey, model: "xiaomi/mimo-v2.5-pro" };
}

function setupFixture(): void {
	rmSync(FIXTURE, { recursive: true, force: true });
	mkdirSync(join(FIXTURE, "mod-a"), { recursive: true });
	mkdirSync(join(FIXTURE, "mod-b"), { recursive: true });
	writeFileSync(
		join(FIXTURE, "mod-a", "greet.ts"),
		`export function greet(name: string): string {\n\treturn "Hello, " + name;\n}\n`,
	);
	writeFileSync(
		join(FIXTURE, "mod-b", "math.ts"),
		`/** Intentional bug for review smoke: divides by zero when b===0. */\nexport function divide(a: number, b: number): number {\n\treturn a / b;\n}\n`,
	);
	writeFileSync(
		join(FIXTURE, "README.md"),
		`# smoke fixture\n\n- mod-a/greet.ts — greeting helper\n- mod-b/math.ts — arithmetic\n`,
	);
}

async function runOne(name: "explore" | "review", assignment: string): Promise<void> {
	const { baseURL, apiKey, model: rawModel } = loadConnection();
	// OpenRouter needs the org/model slug; saved subagentModel may be bare.
	const model = rawModel.includes("/")
		? rawModel
		: rawModel.startsWith("mimo")
			? `xiaomi/${rawModel}`
			: rawModel;
	const config = loadConfig({ baseURL, apiKey });
	const prompts = loadSubagentPrompts();
	const target = prompts.find((p) => p.name === name);
	if (!target?.tools) throw new Error(`${name} missing tools allowlist`);

	const toolsUsed: string[] = [];
	console.log(`\n=== ${name} @ ${model} ===`);
	console.log(`provider: ${new URL(baseURL).host}`);
	console.log(`assignment: ${assignment.slice(0, 120)}…`);

	const result = await execTask({ assignment, subagent: name }, FIXTURE, config, {
		model,
		subagentPrompts: prompts,
		projectTrusted: false,
		confirmBash: async () => true,
		runAgentLoop: async (messages, loopConfig) => {
			const orig = loopConfig.onEvent;
			return runAgentLoop(messages, {
				...loopConfig,
				onEvent: (ev) => {
					if (ev.type === "tool_start") {
						toolsUsed.push(ev.name);
						console.log(`  tool_start: ${ev.name}`);
					} else if (ev.type === "tool_end") {
						console.log(`  tool_end:   ${ev.name}${ev.result.isError ? " ERR" : ""}`);
					} else if (ev.type === "end") {
						console.log(`  end: ${ev.reason}`);
					} else if (ev.type === "error") {
						console.log(`  error: ${ev.message}`);
					} else if (ev.type === "text_delta" && process.env.SMOKE_VERBOSE) {
						process.stdout.write(ev.text);
					}
					orig?.(ev);
				},
			});
		},
	});

	const forbidden = toolsUsed.filter((t) => t === "write" || t === "edit" || t === "task");
	const mutated = existsSync(MUTATION_SENTINEL);
	const passTools = forbidden.length === 0 && !mutated;
	const passContent = !result.isError && (result.content?.length ?? 0) > 40;

	console.log(`\n--- ${name} result ---`);
	console.log(`isError: ${result.isError}`);
	console.log(`tools: ${toolsUsed.join(", ") || "(none)"}`);
	console.log(`forbidden write/edit/task: ${forbidden.join(", ") || "none"}`);
	console.log(`mutated fixture: ${mutated}`);
	console.log(`content (${result.content?.length ?? 0} chars):\n${result.content?.slice(0, 1200)}`);
	console.log(
		`\nVERDICT ${name}: ${passTools && passContent ? "PASS" : "FAIL"} (toolsOk=${passTools} contentOk=${passContent})`,
	);

	if (!passTools || !passContent) process.exitCode = 1;
}

setupFixture();
await runOne(
	"explore",
	"Map this fixture under the current working directory. List modules/entrypoints and what each exports. Cite file paths. Do not modify any files.",
);
await runOne(
	"review",
	"Review mod-b/math.ts for correctness and edge cases. Report findings with file:line. Do not modify any files or invent fixes as patches — prose only.",
);
console.log("\nDone.");
