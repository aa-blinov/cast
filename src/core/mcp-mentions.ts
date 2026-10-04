import type { Message } from "./llm.ts";
import { type McpToolHandle, mcpServerNameFromDescription } from "./mcp.ts";
import { escapeSystemReminderTags } from "./system-reminder.ts";

// `@server:uri`, at the start of a word so an address like name@host:8080 is left alone.
const MENTION_RE = /(?:^|\s)@([A-Za-z0-9_-]+):(\S+)/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]]+$/;
const MAX_MENTIONS = 5;

export interface McpResourceMention {
	server: string;
	uri: string;
}

/** The `@server:uri` references in a message that name a server able to read resources. */
export function findMcpResourceMentions(text: string, canRead: (server: string) => boolean): McpResourceMention[] {
	const found: McpResourceMention[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		const server = match[1]!;
		const uri = match[2]!.replace(TRAILING_PUNCTUATION_RE, "");
		if (uri && canRead(server) && !found.some((m) => m.server === server && m.uri === uri))
			found.push({ server, uri });
	}
	return found.slice(0, MAX_MENTIONS);
}

/**
 * Reads what the person pointed at with `@server:uri` and puts it after their message as a reminder, so the model has
 * the resource without spending a call to ask for it. Returns how many were added.
 */
export async function appendMcpResourceMentions(
	messages: Message[],
	toolIndex: Map<string, McpToolHandle>,
	isAvailable: (toolName: string) => boolean,
	signal?: AbortSignal,
): Promise<number> {
	const last = messages.at(-1);
	if (last?.role !== "user" || typeof last.content !== "string") return 0;
	const readTool = (server: string) => `mcp_${server}_read_resource`;
	const mentions = findMcpResourceMentions(last.content, (server) => isAvailable(readTool(server)));
	if (mentions.length === 0) return 0;
	const blocks = await Promise.all(
		mentions.map(async ({ server, uri }) => {
			const handle = toolIndex.get(readTool(server));
			const result = handle ? await handle.call({ uri }, signal) : undefined;
			const body = result
				? result.isError
					? `(could not be read: ${result.content})`
					: result.content
				: "(no reader)";
			return `<mcp-resource server="${server}" uri="${uri}">\n${escapeSystemReminderTags(body)}\n</mcp-resource>`;
		}),
	);
	messages.push({
		role: "user",
		content: `<system-reminder>\nThe user pointed at MCP resources with @. Their contents, already read:\n\n${blocks.join("\n\n")}\n</system-reminder>`,
	});
	return mentions.length;
}

/**
 * Tells the model which resources it read have changed since, once: a server that offers subscriptions was asked to
 * say so when each was read. The model decides whether the new content matters and reads it again.
 */
export function appendMcpResourceUpdates(messages: Message[], toolIndex: Map<string, McpToolHandle>): number {
	const lines: string[] = [];
	for (const handle of toolIndex.values()) {
		const uris = handle.takeResourceUpdates?.() ?? [];
		if (uris.length === 0) continue;
		const server = mcpServerNameFromDescription(handle.definition.function.description);
		for (const uri of uris) lines.push(`- ${uri} (${server ?? "mcp"})`);
	}
	if (lines.length === 0) return 0;
	messages.push({
		role: "user",
		content: `<system-reminder>\nThese MCP resources changed since you read them. Read one again if the current content matters:\n${escapeSystemReminderTags(lines.join("\n"))}\n</system-reminder>`,
	});
	return lines.length;
}
