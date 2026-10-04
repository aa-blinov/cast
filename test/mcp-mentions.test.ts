import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/llm.ts";
import { closeMcpConnections, connectMcpServers } from "../src/core/mcp.ts";
import {
	appendMcpResourceMentions,
	appendMcpResourceUpdates,
	findMcpResourceMentions,
} from "../src/core/mcp-mentions.ts";

const FIXTURE_SERVER = join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");

describe("findMcpResourceMentions", () => {
	const docs = (server: string) => server === "docs";

	it("finds @server:uri at the start of a word, for a server that can read", () => {
		expect(findMcpResourceMentions("see @docs:file:///docs/readme.md, then fix it", docs)).toEqual([
			{ server: "docs", uri: "file:///docs/readme.md" },
		]);
		expect(findMcpResourceMentions("@docs:notes://7", docs)).toEqual([{ server: "docs", uri: "notes://7" }]);
	});

	it("leaves addresses, other servers and repeats alone", () => {
		expect(findMcpResourceMentions("mail me at ann@docs:8080", docs)).toEqual([]);
		expect(findMcpResourceMentions("@other:thing://1", docs)).toEqual([]);
		expect(findMcpResourceMentions("@docs:a://1 and again @docs:a://1", docs)).toHaveLength(1);
	});

	it("takes at most five", () => {
		const text = [1, 2, 3, 4, 5, 6, 7].map((n) => `@docs:n://${n}`).join(" ");
		expect(findMcpResourceMentions(text, docs)).toHaveLength(5);
	});
});

describe("appendMcpResourceMentions (real spawned server, not mocked)", () => {
	const connect = () => connectMcpServers({ docs: { command: "node", args: [FIXTURE_SERVER, "--resources"] } });

	it("reads what the message points at and puts it after the message as a reminder", async () => {
		const result = await connect();
		try {
			const messages: Message[] = [{ role: "user", content: "summarise @docs:file:///docs/readme.md please" }];
			const added = await appendMcpResourceMentions(messages, result.toolIndex, () => true);
			expect(added).toBe(1);
			expect(messages).toHaveLength(2);
			const reminder = String(messages[1]!.content);
			expect(reminder).toContain("<system-reminder>");
			expect(reminder).toContain('<mcp-resource server="docs" uri="file:///docs/readme.md">');
			expect(reminder).toContain("Deploy step 3 is: flush the cache.");
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("says when a resource cannot be read, and skips a server the persona may not use", async () => {
		const result = await connect();
		try {
			const missing: Message[] = [{ role: "user", content: "@docs:nope://x" }];
			await appendMcpResourceMentions(missing, result.toolIndex, () => true);
			expect(String(missing[1]!.content)).toContain("could not be read");

			const denied: Message[] = [{ role: "user", content: "@docs:file:///docs/readme.md" }];
			expect(await appendMcpResourceMentions(denied, result.toolIndex, () => false)).toBe(0);
			expect(denied).toHaveLength(1);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("does nothing when the last message is not the person's text", async () => {
		const messages: Message[] = [{ role: "assistant", content: "@docs:file:///docs/readme.md" }];
		expect(await appendMcpResourceMentions(messages, new Map(), () => true)).toBe(0);
	});
});

describe("appendMcpResourceUpdates (real spawned server, not mocked)", () => {
	it("tells the model once that a resource it read has changed", async () => {
		const result = await connectMcpServers({
			docs: { command: "node", args: [FIXTURE_SERVER, "--resources", "--subscribe"] },
		});
		try {
			const tool = (name: string) => result.toolIndex.get(`mcp_docs_${name}`)!;
			const quiet: Message[] = [{ role: "user", content: "hi" }];
			expect(appendMcpResourceUpdates(quiet, result.toolIndex)).toBe(0);

			await tool("read_resource").call({ uri: "file:///docs/readme.md" });
			await tool("touch").call({});
			const messages: Message[] = [{ role: "user", content: "what now" }];
			for (let i = 0; i < 100 && messages.length === 1; i++) {
				appendMcpResourceUpdates(messages, result.toolIndex);
				if (messages.length === 1) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(messages).toHaveLength(2);
			expect(String(messages[1]!.content)).toContain("file:///docs/readme.md (docs)");
			expect(appendMcpResourceUpdates([{ role: "user", content: "again" }], result.toolIndex)).toBe(0);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});

	it("ignores a change to something that was never read", async () => {
		const result = await connectMcpServers({
			docs: { command: "node", args: [FIXTURE_SERVER, "--resources", "--subscribe"] },
		});
		try {
			expect((await result.toolIndex.get("mcp_docs_touch")!.call({})).content).toBe("watched: ");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(appendMcpResourceUpdates([{ role: "user", content: "x" }], result.toolIndex)).toBe(0);
		} finally {
			await closeMcpConnections(result.connections);
		}
	});
});
