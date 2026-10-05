import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "./llm.ts";
import type { SessionState } from "./session.ts";
import { querySessionCost, type SessionCostRow } from "./telemetry.ts";

const TOOL_RESULT_MAX_CHARS = 2_000;

const n = (value: number) => value.toLocaleString("en-US");
const usd = (value: number) => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;

/**
 * `/cost`: what the session has spent. The totals come from the session itself, the per-kind rows from telemetry, which
 * is where the work the conversation does not show (subagents, compaction, `/btw`) is counted; telemetry is pruned
 * after its retention, so an old session may have totals and no rows.
 */
export function formatCost(session: SessionState, rows: SessionCostRow[]): string {
	const u = session.usage;
	const lines = [
		`Session ${session.id.slice(0, 8)} on ${session.model}`,
		`Tokens: ${n(u.totalTokens)} (${n(u.promptTokens)} in, ${n(u.completionTokens)} out)`,
	];
	const cacheable = u.cacheReadTokens + u.cacheWriteTokens + u.uncachedTokens;
	if (cacheable > 0)
		lines.push(`Cache: ${Math.round((u.cacheReadTokens / cacheable) * 100)}% of input read from cache`);
	if (u.subagentTokens > 0) lines.push(`Subagents: ${n(u.subagentTokens)} tokens`);
	lines.push(u.cost > 0 ? `Cost: ${usd(u.cost)}` : "Cost: not reported by the provider");
	if (rows.length > 0) {
		lines.push("", "By kind of request:");
		for (const r of rows) {
			const price = r.cost === null ? "" : `, ${usd(r.cost)}`;
			lines.push(
				`  ${r.kind}: ${n(r.requests)} request${r.requests === 1 ? "" : "s"}, ${n(r.promptTokens)} in, ${n(r.completionTokens)} out${price}`,
			);
		}
	}
	return lines.join("\n");
}

function text(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

const fence = (body: string) => {
	// A fence longer than any run of backticks inside, so tool output cannot close it early.
	const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
	const mark = "`".repeat(longest + 1);
	return `${mark}\n${body}\n${mark}`;
};

/** `/export`: the conversation as Markdown. System prompts are left out; they are the harness's, not the conversation. */
export function exportMarkdown(session: SessionState): string {
	const out = [`# ${session.title?.trim() || `Session ${session.id.slice(0, 8)}`}`, ""];
	out.push(`- Session: ${session.id}`, `- Model: ${session.model}`, `- Started: ${session.createdAt}`);
	if (session.cwd) out.push(`- Folder: ${session.cwd}`);
	out.push("");
	const names = new Map<string, string>();
	for (const m of session.messages) {
		if (m.role === "system" || m.role === "developer") continue;
		if (m.role === "user") {
			out.push("## User", "", text(m.content), "");
		} else if (m.role === "assistant") {
			const body = text(m.content);
			const calls = (m.tool_calls ?? []).filter((c) => c.type === "function");
			for (const c of calls) names.set(c.id, c.function.name);
			if (!body && calls.length === 0) continue;
			out.push("## Assistant", "");
			if (body) out.push(body, "");
			for (const c of calls) out.push(`Tool call \`${c.function.name}\`:`, "", fence(c.function.arguments), "");
		} else if (m.role === "tool") {
			const body = text(m.content);
			const clipped =
				body.length > TOOL_RESULT_MAX_CHARS
					? `${body.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (${n(body.length - TOOL_RESULT_MAX_CHARS)} more characters)`
					: body;
			out.push(`Result of \`${names.get(m.tool_call_id) ?? "tool"}\`:`, "", fence(clipped), "");
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}

export function exportFileName(session: SessionState): string {
	const slug = (session.title ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${slug ? `${slug}-` : ""}${session.id.slice(0, 8)}.md`;
}

/** `/cost` for a live session, from what it holds and what telemetry recorded for it. */
export function sessionCostText(session: SessionState): string {
	return formatCost(session, querySessionCost(session.id));
}

/** Writes the Markdown export under `~/.cast/exports/` (a place of its own: never the user's project) and returns its path. */
export function saveExport(session: SessionState): string {
	const dir = join(homedir(), ".cast", "exports");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, exportFileName(session));
	writeFileSync(path, exportMarkdown(session), { mode: 0o600 });
	return path;
}
