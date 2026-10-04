import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpInteraction } from "../src/core/mcp-interaction.ts";

const signal = new AbortController().signal;
const params = {
	messages: [{ role: "user" as const, content: { type: "text" as const, text: "what is 2+2?" } }],
	maxTokens: 20,
};

describe("createMcpInteraction sampling", () => {
	it("asks the person first and sends the server's conversation to the model", async () => {
		const confirm = vi.fn(async () => true);
		const complete = vi.fn(async () => ({ text: "4", truncated: false }));
		const interaction = createMcpInteraction({ complete, model: "m", confirm, bypass: false });
		const answer = await interaction.sample("calc", { ...params, systemPrompt: "be brief" }, signal);
		expect(answer).toEqual({
			role: "assistant",
			model: "m",
			content: { type: "text", text: "4" },
			stopReason: "endTurn",
		});
		expect(confirm.mock.calls[0]![0]).toContain("calc");
		expect(confirm.mock.calls[0]![0]).toContain("what is 2+2?");
		expect(complete).toHaveBeenCalledWith(
			[
				{ role: "system", content: "be brief" },
				{ role: "user", content: "what is 2+2?" },
			],
			20,
			signal,
		);
	});

	it("reports a cut-off answer as maxTokens", async () => {
		const interaction = createMcpInteraction({
			complete: async () => ({ text: "4 and", truncated: true }),
			model: "m",
			confirm: async () => true,
			bypass: false,
		});
		expect((await interaction.sample("calc", params, signal)).stopReason).toBe("maxTokens");
	});

	it("does not call the model when the person says no", async () => {
		const complete = vi.fn();
		const interaction = createMcpInteraction({ complete, model: "m", confirm: async () => false, bypass: false });
		await expect(interaction.sample("calc", params, signal)).rejects.toThrow(McpError);
		expect(complete).not.toHaveBeenCalled();
	});

	it("refuses when nobody can be asked, but runs in a mode that never asks", async () => {
		const complete = vi.fn(async () => ({ text: "4", truncated: false }));
		await expect(
			createMcpInteraction({ complete, model: "m", bypass: false }).sample("calc", params, signal),
		).rejects.toThrow(/approval/);
		expect(
			(await createMcpInteraction({ complete, model: "m", bypass: true }).sample("calc", params, signal)).content,
		).toEqual({
			type: "text",
			text: "4",
		});
	});

	it("passes an image to the model as an image", async () => {
		const complete = vi.fn(async () => ({ text: "a cat", truncated: false }));
		const interaction = createMcpInteraction({ complete, model: "m", bypass: true });
		await interaction.sample(
			"vision",
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "what is this?" },
							{ type: "image", data: "AAAA", mimeType: "image/png" },
						],
					},
				],
				maxTokens: 10,
			},
			signal,
		);
		expect(complete.mock.calls[0]![0]).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this?" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
				],
			},
		]);
	});
});

describe("createMcpInteraction elicitation", () => {
	it("declines when there is nobody to ask", async () => {
		const interaction = createMcpInteraction({ complete: vi.fn(), model: "m", bypass: false });
		expect(
			await interaction.elicit(
				"s",
				{ message: "name?", requestedSchema: { type: "object", properties: {} } },
				signal,
			),
		).toEqual({
			action: "decline",
		});
	});

	it("hands the form to whoever shows it", async () => {
		const askForm = vi.fn(async () => ({ action: "accept" as const, content: { name: "Ada" } }));
		const interaction = createMcpInteraction({ complete: vi.fn(), model: "m", bypass: false, askForm });
		const request = { message: "name?", requestedSchema: { type: "object" as const, properties: {} } };
		expect(await interaction.elicit("s", request, signal)).toEqual({ action: "accept", content: { name: "Ada" } });
		expect(askForm).toHaveBeenCalledWith("s", request, signal);
	});
});
