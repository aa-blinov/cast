/**
 * Organic parent smoke: coder-with-subagents should pick explore/review
 * via task(subagent=…) without the harness forcing the type.
 *
 *   npx tsx test/__test_tmp__/smoke-organic-subagents.mts
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../../src/core/config.ts";
import { runAgentLoop } from "../../src/core/loop.ts";
import { findPersona, listPersonas } from "../../src/core/personas.ts";
import { formatSystemEnvironmentBlock } from "../../src/core/project.ts";
import { loadSubagentPrompts } from "../../src/core/subagents.ts";

const FIXTURE = join(import.meta.dirname, "smoke-organic-fixture");

type TaskCall = { subagent: string; assignment: string };

function loadConnection(): { baseURL: string; apiKey: string; model: string; subagentModel: string } {
	const settingsPath = join(homedir(), ".cast/settings.json");
	const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
		providerUrl?: string;
		apiKey?: string;
		model?: string;
		subagentModel?: string;
		providers?: Array<{ url?: string; apiKey?: string }>;
	};
	const fromProviders = s.providers?.[0];
	const baseURL = s.providerUrl || fromProviders?.url;
	const apiKey = s.apiKey || fromProviders?.apiKey;
	if (!baseURL || !apiKey) throw new Error("Need providerUrl/apiKey in ~/.cast/settings.json");
	const bare = (id: string) =>
		id.includes("/") ? id : id.startsWith("mimo") ? `xiaomi/${id}` : id;
	const model = bare(s.model || "xiaomi/mimo-v2.5-pro");
	const subagentModel = bare(s.subagentModel || model);
	return { baseURL, apiKey, model, subagentModel };
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
		`/** Intentional bug: divides by zero when b===0. */\nexport function divide(a: number, b: number): number {\n\treturn a / b;\n}\n`,
	);
	writeFileSync(join(FIXTURE, "README.md"), `# organic smoke\n\nmod-a + mod-b\n`);
}

function parseTaskArgs(argsJson: string): TaskCall | null {
	try {
		const obj = JSON.parse(argsJson) as Record<string, unknown>;
		const assignment = typeof obj.assignment === "string" ? obj.assignment : "";
		if (!assignment) return null;
		const subagent = typeof obj.subagent === "string" && obj.subagent.trim() ? obj.subagent.trim() : "(default/worker)";
		return { subagent, assignment };
	} catch {
		return null;
	}
}

async function runParent(label: string, userText: string, expectSubagents: string[]): Promise<boolean> {
	const { baseURL, apiKey, model, subagentModel } = loadConnection();
	const config = loadConfig({ baseURL, apiKey });
	const persona = findPersona("coder-with-subagents", listPersonas());
	if (!persona) throw new Error("coder-with-subagents not found");
	const subagentPrompts = loadSubagentPrompts();
	const systemPrompt =
		persona.systemPrompt +
		formatSystemEnvironmentBlock(FIXTURE, {
			model,
			reasoningLevel: config.reasoningLevel,
			mode: "build",
			persona,
		});

	const taskCalls: TaskCall[] = [];
	const toolsUsed: string[] = [];
	let finalText = "";

	console.log(`\n=== ${label} ===`);
	console.log(`parent=${model} child=${subagentModel}`);
	console.log(`user: ${userText}`);

	await runAgentLoop([{ role: "user", content: userText }], {
		config,
		model,
		cwd: FIXTURE,
		systemPrompt,
		currentPersona: persona.name,
		personas: [persona],
		subagentPrompts,
		subagentModel,
		projectTrusted: false,
		confirmBash: async () => true,
		onEvent: (ev) => {
			if (ev.type === "tool_start") {
				toolsUsed.push(ev.name);
				if (ev.name === "task") {
					const parsed = parseTaskArgs(ev.args);
					if (parsed) {
						taskCalls.push(parsed);
						console.log(`  task → subagent=${parsed.subagent}`);
						console.log(`         ${parsed.assignment.slice(0, 140)}${parsed.assignment.length > 140 ? "…" : ""}`);
					} else {
						console.log(`  task → (unparseable args)`);
					}
				} else {
					console.log(`  tool_start: ${ev.name}`);
				}
			} else if (ev.type === "tool_end" && ev.name === "task") {
				const preview = (ev.result.content ?? "").slice(0, 160).replace(/\n/g, " ");
				console.log(`  task_end${ev.result.isError ? " ERR" : ""}: ${preview}…`);
			} else if (ev.type === "token") {
				finalText += ev.text;
			} else if (ev.type === "assistant_message" && ev.content) {
				finalText = ev.content;
			} else if (ev.type === "error") {
				console.log(`  error: ${ev.message}`);
			} else if (ev.type === "end") {
				console.log(`  end: ${ev.reason}`);
			}
		},
	});

	const chosen = taskCalls.map((c) => c.subagent);
	const hitExpected = expectSubagents.every((want) =>
		chosen.some((c) => c === want || (want === "worker" && (c === "worker" || c === "(default/worker)"))),
	);
	const usedTask = taskCalls.length > 0;
	const pass = usedTask && hitExpected;

	console.log(`\n--- ${label} summary ---`);
	console.log(`parent tools: ${toolsUsed.join(", ") || "(none)"}`);
	console.log(`task subagents chosen: ${chosen.join(" | ") || "(none)"}`);
	console.log(`expected to include: ${expectSubagents.join(", ")}`);
	console.log(`final text (${finalText.length} chars): ${finalText.slice(0, 400).replace(/\n/g, " ")}`);
	console.log(`VERDICT ${label}: ${pass ? "PASS" : "FAIL"}`);
	return pass;
}

setupFixture();

const exploreOk = await runParent(
	"organic-explore",
	"Параллельно и независимо исследуй mod-a/ и mod-b/: что экспортируют, какие entrypoints. " +
		"Не правь файлы сам — делегируй исследование сабагентам через task. Кратко синтезируй их отчёты.",
	["explore"],
);

const reviewOk = await runParent(
	"organic-review",
	"Сделай независимый code review файла mod-b/math.ts: correctness и edge cases. " +
		"Не правь код сам — делегируй review сабагенту через task, потом кратко перескажи findings.",
	["review"],
);

console.log(`\n=== OVERALL: explore=${exploreOk ? "PASS" : "FAIL"} review=${reviewOk ? "PASS" : "FAIL"} ===`);
if (!exploreOk || !reviewOk) process.exitCode = 1;
