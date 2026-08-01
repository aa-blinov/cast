/** Rebuild scoreboard turn metrics and provider URLs from recorded eval runs. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recomputeScoreboardEntry, type ScoreboardEntry } from "../evals/lib/scoreboard.ts";

const ROOT = join(import.meta.dirname, "..");
const SCOREBOARD_PATH = join(ROOT, "docs", "eval-scoreboard.json");
const INDEX_PATH = join(ROOT, "evals", "results", "index.json");

type IndexEntry = { file: string };
type Attempt = { turns?: number };
type Case = { id: string; attempts?: Attempt[] };
type RecordedRun = { perModel?: Record<string, { cases?: Case[] }> };
type Settings = { providers?: Array<{ name: string; url: string }> };

function bareModel(model: string): string {
	const separator = model.indexOf(":");
	return separator > 0 ? model.slice(separator + 1) : model;
}

function providerName(model: string): string | undefined {
	const separator = model.indexOf(":");
	return separator > 0 ? model.slice(0, separator) : undefined;
}

const scoreboard = JSON.parse(readFileSync(SCOREBOARD_PATH, "utf-8")) as Record<string, ScoreboardEntry>;
const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as IndexEntry[];
const settingsPath = join(homedir(), ".cast", "settings.json");
const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings) : {};
const providerUrls = new Map((settings.providers ?? []).map((provider) => [provider.name, provider.url]));

for (const [model, entry] of Object.entries(scoreboard)) {
	const pending = new Set(entry.results.filter((result) => !result.turns?.length).map((result) => result.caseId));
	let url = entry.providerUrl;
	for (const record of [...index].reverse()) {
		const path = join(ROOT, "evals", "results", record.file);
		if (!existsSync(path)) continue;
		const run = JSON.parse(readFileSync(path, "utf-8")) as RecordedRun;
		for (const [rawModel, suite] of Object.entries(run.perModel ?? {})) {
			if (bareModel(rawModel) !== model) continue;
			url ??= providerUrls.get(providerName(rawModel) ?? "");
			for (const recordedCase of suite.cases ?? []) {
				if (!pending.has(recordedCase.id)) continue;
				const target = entry.results.find((result) => result.caseId === recordedCase.id);
				if (target && recordedCase.attempts?.length) target.turns = recordedCase.attempts.map((attempt) => attempt.turns ?? 0);
				pending.delete(recordedCase.id);
			}
		}
		if (pending.size === 0 && url) break;
	}
	scoreboard[model] = recomputeScoreboardEntry({ ...entry, ...(url ? { providerUrl: url } : {}) });
	if (pending.size > 0) console.warn(`${model}: missing turns for ${[...pending].join(", ")}`);
}

writeFileSync(SCOREBOARD_PATH, `${JSON.stringify(scoreboard, null, 2)}\n`, "utf-8");
