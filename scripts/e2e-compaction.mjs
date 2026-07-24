#!/usr/bin/env node
// End-to-end smoke test for the compaction guard fix in src/core/loop.ts,
// driven against the REAL configured provider (real LLM calls — costs
// tokens). Run with: node --import tsx scripts/e2e-compaction.mjs
//
// Unlike scripts/e2e-plan-mode.sh (drives the TUI via tmux), this calls
// runAgentLoop directly with a deliberately tiny contextWindow — the real
// loadConfig() hardcodes 128k, which would need ~90k real tokens of history
// to reach the compaction threshold. A tiny window makes the same code path
// reachable for a few cents instead of a full-context run.
//
// Three real-model scenarios, each a fresh runAgentLoop call:
//   1. Small tool result, budget never approached -> no compaction.
//   2. Model reads a large real file -> mid-turn guard compacts BEFORE the
//      next real completion call (this is the fix under test).
//   3. Top-of-turn shouldCompact (existing path) still compacts using a
//      real lastPromptTokens reading from the previous real response.
//
// Requires: ~/.cast/settings.json with a working provider.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const settingsPath = join(homedir(), ".cast", "settings.json");
if (!existsSync(settingsPath)) {
	console.log("SKIP: no provider configured (~/.cast/settings.json)");
	process.exit(0);
}
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
const baseURL = settings.providerUrl;
const apiKey = settings.apiKey;
const model = settings.model;
if (!baseURL || !apiKey || !model) {
	console.log("SKIP: settings.json missing providerUrl/apiKey/model");
	process.exit(0);
}

const { runAgentLoop } = await import("../src/core/loop.ts");

let failures = 0;
function check(cond, msg) {
	if (cond) {
		console.log(`ok: ${msg}`);
	} else {
		failures++;
		console.log(`FAIL: ${msg}`);
	}
}

// Deliberately tiny — real conversations blow past this in one or two
// turns, which is the whole point (cheap to trigger for real).
const tinyConfig = {
	baseURL,
	apiKey,
	contextWindow: 3000,
	maxResponseTokens: 300,
	compactionThreshold: 0.6,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 60,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
};

const systemPrompt = "You are a terminal coding assistant. Be extremely brief — one short sentence per reply.";

function summarizeEvents(events) {
	const types = events.map((e) => e.type);
	const counts = {};
	for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
	return counts;
}

// ---------------------------------------------------------------------------
// Scenario 1: small tool result, well under threshold -> no compaction.
// ---------------------------------------------------------------------------
async function scenarioSmall() {
	console.log("\n== scenario 1: small tool result (expect no compaction) ==");
	const cwd = mkdtempSync(join(tmpdir(), "cast-e2e-compact-small-"));
	try {
		writeFileSync(join(cwd, "small.txt"), "hello world\n");
		const events = [];
		await runAgentLoop(
			[{ role: "user", content: "Read small.txt with the read tool, then tell me its exact contents in one sentence." }],
			{
				config: tinyConfig,
				model,
				cwd,
				systemPrompt,
				onEvent: (e) => events.push(e),
			},
		);
		console.log("events:", summarizeEvents(events));
		check(!events.some((e) => e.type === "compaction"), "no compaction fired for a tiny tool result");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Scenario 2: model reads a large real file -> mid-turn guard should compact
// BEFORE the follow-up completion call. This is the exact fix under test.
// ---------------------------------------------------------------------------
async function scenarioLargeToolResult() {
	console.log("\n== scenario 2: large tool result mid-turn (expect mid-turn compaction) ==");
	const cwd = mkdtempSync(join(tmpdir(), "cast-e2e-compact-large-"));
	try {
		// ~15k chars, well over tinyConfig's ~1400-token compaction threshold
		// once it lands in the tool result.
		const big = Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join(
			"\n",
		);
		writeFileSync(join(cwd, "big.txt"), big);

		const events = [];

		// compactMessages needs a real turn boundary to cut at (safeCutIndex
		// finds no safe split on a single fresh exchange) — a throwaway first
		// turn gives it one, same as a real multi-turn session would have by
		// the time context actually grows this large.
		let messages = await runAgentLoop([{ role: "user", content: "Say 'hi' and nothing else." }], {
			config: tinyConfig,
			model,
			cwd,
			systemPrompt,
			onEvent: (e) => events.push(e),
		});

		messages.push({ role: "user", content: "Read big.txt with the read tool, then just say 'done' — nothing else." });

		await runAgentLoop(messages, {
			config: tinyConfig,
			model,
			cwd,
			systemPrompt,
			onEvent: (e) => events.push(e),
		});

		console.log("events:", summarizeEvents(events));
		const compactionEvents = events.filter((e) => e.type === "compaction");
		check(compactionEvents.length >= 1, "compaction fired after the large tool result");
		check(
			!events.some((e) => e.type === "compaction_failed"),
			"compaction did not fail",
		);
		if (compactionEvents.length > 0) {
			check(compactionEvents[0].messagesCompacted > 0, "compaction actually dropped messages, not a no-op");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Scenario 3: multi-turn conversation grows past threshold over several
// real turns -> top-of-turn shouldCompact (existing path, using the real
// provider's reported prompt tokens) should still fire.
// ---------------------------------------------------------------------------
async function scenarioMultiTurnGrowth() {
	console.log("\n== scenario 3: multi-turn growth (expect top-of-turn compaction) ==");
	const cwd = mkdtempSync(join(tmpdir(), "cast-e2e-compact-multiturn-"));
	try {
		const events = [];
		let lastPromptTokens;
		const config = { ...tinyConfig, contextWindow: 4000, maxResponseTokens: 300 };

		let messages = [
			{
				role: "user",
				content:
					"Write a two-paragraph story about a robot learning to paint. Do not use any tools, just reply with the story.",
			},
		];

		// Turn 1: no lastPromptTokens yet, just establishes real usage.
		messages = await runAgentLoop(messages, {
			config,
			model,
			cwd,
			systemPrompt,
			onEvent: (e) => {
				events.push(e);
				if (e.type === "usage") lastPromptTokens = e.usage.promptTokens ?? lastPromptTokens;
			},
		});
		console.log("after turn 1, lastPromptTokens:", lastPromptTokens);

		messages.push({
			role: "user",
			content: "Now write another two-paragraph story, this time about the robot's first exhibition.",
		});

		// Turn 2: shouldCompact runs at the top with the real lastPromptTokens
		// from turn 1. With a 4000-token window and two real story turns, this
		// should already be over the 0.6 threshold.
		await runAgentLoop(messages, {
			config,
			model,
			cwd,
			systemPrompt,
			lastPromptTokens,
			onEvent: (e) => events.push(e),
		});

		console.log("events:", summarizeEvents(events));
		check(events.some((e) => e.type === "compaction"), "top-of-turn shouldCompact fired using real prompt tokens");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

await scenarioSmall();
await scenarioLargeToolResult();
await scenarioMultiTurnGrowth();

console.log(failures === 0 ? "\nPASS: compaction e2e" : `\nFAIL: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
