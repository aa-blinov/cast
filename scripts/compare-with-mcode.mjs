#!/usr/bin/env node
/**
 * cast vs mcode on the same task, the same model, the same repository.
 *
 * The behaviour bench (evals/) measures cast against contracts it defines.
 * This measures the thing a person switching harnesses actually cares about:
 * does the agent get the work done, and how long does it take. Both harnesses
 * get the same prompt, the same model, the same starting repository, and the
 * same grading — the task's own test suite, plus a hidden test the agent never
 * saw, so "the tests pass" cannot be the agent's own tests passing.
 *
 * Needs: cast on PATH (the checkout's cast.sh or an installed release), mcode
 * (https://www.npmjs.com/package/@minimax-ai/code — `mcode exec` runs one
 * prompt without the TUI), and a MiniMax API key in MINIMAX_API_KEY.
 *
 *   node scripts/compare-with-mcode.mjs --runs 2
 *   node scripts/compare-with-mcode.mjs --task task4 --runs 3
 *
 * Writes a JSON report to scripts/compare-report.json and prints a table.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(HERE, "compare-tasks");
const MODEL = process.env.COMPARE_MODEL ?? "MiniMax-M3.1-Flash";

function argument(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const runs = Number(argument("runs", "2"));
const only = argument("task", "");
const mcodeBin = argument("mcode", join(homedir(), ".minimax-code", "bin", "mcode"));
const provider = argument("provider", "custom_provider:minimax-direct");
const outFile = argument("out", join(HERE, "compare-report.json"));

if (!process.env.MINIMAX_API_KEY) {
	console.error("MINIMAX_API_KEY is not set — both harnesses need the same key to compare fairly.");
	process.exit(2);
}
if (!existsSync(mcodeBin)) {
	console.error(`mcode not found at ${mcodeBin} — pass --mcode <path>.`);
	process.exit(2);
}

const tasks = readdirSync(TASKS_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => !only || name === only)
	.sort();

/** Run a command with its output in a file — spawnSync takes descriptors, not paths. */
function runToFile(cmd, args, options, outPath, errPath) {
	const out = openSync(outPath, "w");
	const err = openSync(errPath, "w");
	try {
		return run(cmd, args, { ...options, stdio: ["ignore", out, err] });
	} finally {
		closeSync(out);
		closeSync(err);
	}
}

function run(cmd, args, options) {
	const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: 30 * 60_000, ...options });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function copyTask(task, work) {
	cpSync(join(TASKS_DIR, task), work, { recursive: true });
	// The hidden test is the grader's, not the agent's: it is held back until
	// the run is over.
	const hidden = join(work, "hidden.test.js");
	if (existsSync(hidden)) {
		rmSync(hidden);
		writeFileSync(join(work, ".hidden-test.js"), readFileSync(join(TASKS_DIR, task, "hidden.test.js")));
	}
}

function grade(task, work) {
	const suite = run("node", ["--test", "test/"], { cwd: work });
	let hidden = "n/a";
	const hiddenCopy = join(work, ".hidden-test.js");
	if (existsSync(hiddenCopy)) {
		cpSync(hiddenCopy, join(work, "test", "hidden.test.js"));
		const hiddenRun = run("node", ["--test", "test/"], { cwd: work });
		hidden = hiddenRun.status === 0 ? "pass" : "fail";
		rmSync(join(work, "test", "hidden.test.js"));
	}
	const diff = run("git", ["diff", "--stat", "HEAD"], { cwd: work }).stdout.trim();
	const touchedTests = diff.split("\n").filter((line) => line.trim().startsWith("test/")).length;
	return { suite: suite.status === 0 ? "pass" : "fail", hidden, touchedTests };
}

function castRun(task, work) {
	const out = join(work, ".agent.jsonl");
	const started = Date.now();
	const result = runToFile(
		"cast",
		["run", "--format", "json", "--bypass-permissions", readFileSync(join(TASKS_DIR, task, "task.md"), "utf-8")],
		{ cwd: work },
		out,
		join(work, ".agent.err"),
	);
	const elapsed = Math.round((Date.now() - started) / 1000);
	let toolCalls = 0;
	let turns = 0;
	let promptTokens = 0;
	let completionTokens = 0;
	for (const line of readFileSync(out, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "tool_start") toolCalls++;
		if (event.type === "assistant_message") turns++;
		if (event.type === "usage") {
			promptTokens += event.usage?.promptTokens ?? 0;
			completionTokens += event.usage?.completionTokens ?? 0;
		}
	}
	return { harness: "cast", elapsed, toolCalls, turns, promptTokens, completionTokens, exit: result.status };
}

function mcodeRun(task, work) {
	const out = join(work, ".agent.json");
	const diag = join(work, ".diag");
	const started = Date.now();
	const result = runToFile(
		mcodeBin,
		[
			"exec",
			"--cwd",
			work,
			"--model",
			`${provider}/${MODEL}`,
			"--permission",
			"off",
			"--timeout",
			"30m",
			"--output-format",
			"json",
			"--diagnostics-dir",
			diag,
			readFileSync(join(TASKS_DIR, task, "task.md"), "utf-8"),
		],
		{ cwd: work },
		out,
		join(work, ".agent.err"),
	);
	const elapsed = Math.round((Date.now() - started) / 1000);
	let toolCalls;
	let steps;
	const statusFile = join(diag, "diagnostics-status.json");
	if (existsSync(statusFile)) {
		const status = JSON.parse(readFileSync(statusFile, "utf-8"));
		toolCalls = status.toolCalls;
		steps = status.modelSteps;
	}
	return { harness: "mcode", elapsed, toolCalls, turns: steps, exit: result.status };
}

const report = [];
for (const task of tasks) {
	for (const harness of ["cast", "mcode"]) {
		for (let attempt = 1; attempt <= runs; attempt++) {
			const work = mkdtempSync(join(tmpdir(), `cast-vs-mcode-${task}-`));
			copyTask(task, work);
			execFileSync("git", ["init", "-q", "."], { cwd: work });
			execFileSync("git", ["add", "-A"], { cwd: work });
			execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=c", "commit", "-qm", "init"], { cwd: work });
			const metrics = harness === "cast" ? castRun(task, work) : mcodeRun(task, work);
			const grades = grade(task, work);
			const row = { task, attempt, ...metrics, ...grades };
			report.push(row);
			console.log(
				`${row.task} ${row.harness.padEnd(6)} #${attempt}  suite=${row.suite} hidden=${row.hidden} ` +
					`tests-touched=${row.touchedTests} ${row.elapsed}s tools=${row.toolCalls ?? "?"}`,
			);
			rmSync(work, { recursive: true, force: true });
		}
	}
}

writeFileSync(outFile, `${JSON.stringify({ model: MODEL, at: new Date().toISOString(), report }, null, 1)}\n`);
console.log(`\nReport: ${outFile}`);

const summary = new Map();
for (const row of report) {
	const key = `${row.harness}`;
	if (!summary.has(key)) summary.set(key, { pass: 0, total: 0, seconds: 0, tools: 0 });
	const entry = summary.get(key);
	entry.total++;
	if (row.suite === "pass" && (row.hidden === "pass" || row.hidden === "n/a")) entry.pass++;
	entry.seconds += row.elapsed;
	entry.tools += row.toolCalls ?? 0;
}
console.log("\nharness   solved   avg time   avg tool calls");
for (const [harness, entry] of summary) {
	console.log(
		`${harness.padEnd(9)} ${String(entry.pass).padStart(3)}/${String(entry.total).padEnd(4)} ` +
			`${(entry.seconds / entry.total).toFixed(1).padStart(6)}s   ${(entry.tools / entry.total).toFixed(1).padStart(6)}`,
	);
}
