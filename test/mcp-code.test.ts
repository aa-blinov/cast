import { describe, expect, it } from "vitest";
import type { Tool } from "../src/core/llm.ts";
import { mcpCodeDeclarations, mcpCodeToolDefinition, runMcpScript, scriptTools } from "../src/core/mcp-code.ts";
import type { ToolResult } from "../src/core/tools/shared.ts";

const mcpTools: Tool[] = [
	{
		type: "function",
		function: {
			name: "mcp_shop_get_order",
			description: "[shop] Fetch one order. Returns its lines.",
			parameters: {
				type: "object",
				properties: {
					orderId: { type: "string", description: "Order id. Looked up by exact match." },
					expand: { type: "array", items: { type: "integer" } },
					order: { type: "object", additionalProperties: { type: "string", enum: ["asc", "desc"] } },
				},
				required: ["orderId"],
			},
		},
	},
	{
		type: "function",
		function: { name: "mcp_shop_create-order", description: "[shop] Create an order", parameters: {} },
	},
];
const builtinTools: Tool[] = ["read", "grep", "bash", "todo"].map((name) => ({
	type: "function",
	function: {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
}));
const tools = scriptTools(mcpTools, builtinTools);

function run(
	code: string,
	call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
	timeoutMs = 20_000,
) {
	return runMcpScript({ code, tools, call, timeoutMs });
}

describe("mcp code mode", () => {
	it("groups tools by server, puts only read-only built-ins in fs and web, and keeps names dot-accessible", () => {
		expect(tools.map((t) => `${t.ns}.${t.name}`)).toEqual([
			"shop.get_order",
			"shop.create_order",
			"fs.read",
			"fs.grep",
		]);
	});

	it("declares signatures with parameter notes and the values of a free-form map", () => {
		const dts = mcpCodeDeclarations(tools);
		expect(dts.startsWith("declare const codemode: {")).toBe(true);
		expect(dts).toContain("shop: {");
		expect(dts).toContain("/** Fetch one order */ get_order(args: {");
		expect(dts).toContain("/** Order id */ orderId:string");
		expect(dts).toContain("expand?:number[]");
		expect(dts).toContain('order?:{[key:string]:"asc"|"desc"}');
		expect(mcpCodeToolDefinition(tools).function.description).toContain(dts);
	});

	it("chains calls in one script and returns only the final value", async () => {
		const seen: string[] = [];
		const result = await run(
			`const o = await codemode.shop.get_order({ orderId: "7" });
			 const all = await codemode.fs.grep({ path: "." });
			 console.log("two calls");
			 return { id: o.id, count: all.length };`,
			async (name) => {
				seen.push(name);
				return { content: name === "mcp_shop_get_order" ? '{"id":"7","big":"xxxxx"}' : "[1,2,3]" };
			},
		);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content.split("\n\n")[0]!)).toEqual({ id: "7", count: 3 });
		expect(result.content).toContain("two calls");
		expect(result.content).toContain("[calls: shop.get_order, fs.grep]");
		expect(seen).toEqual(["mcp_shop_get_order", "grep"]);
	});

	it("throws a failed tool call inside the script so it can be caught", async () => {
		const result = await run(
			"try { await codemode.shop.get_order({}); } catch (e) { return 'caught: ' + e.message; }",
			async () => ({ content: "no such order", isError: true }),
		);
		expect(result.content).toContain("caught: no such order");
	});

	it("refuses a tool that was not declared without calling out", async () => {
		let called = false;
		const result = await run("return await codemode.shop.delete_everything({});", async () => {
			called = true;
			return { content: "x" };
		});
		expect(called).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown tool "shop.delete_everything"');
		expect(result.content).toContain("namespaces: shop, fs");
	});

	it("has no file system or shell", async () => {
		const result = await run(
			`const fs = process.getBuiltinModule("node:fs");
			 const cp = process.getBuiltinModule("node:child_process");
			 const out = [];
			 try { fs.readFileSync("/etc/hostname"); out.push("fs open"); } catch (e) { out.push(e.code); }
			 try { cp.execSync("id"); out.push("exec open"); } catch (e) { out.push(e.code); }
			 return out;`,
			async () => ({ content: "" }),
		);
		expect(JSON.parse(result.content.split("\n\n")[0]!)).toEqual(["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
	});

	it("does not pass credential-looking environment variables into the script", async () => {
		process.env.CAST_TEST_API_KEY = "leak-me";
		try {
			const result = await run("return process.env.CAST_TEST_API_KEY ?? 'absent';", async () => ({ content: "" }));
			expect(result.content).toContain("absent");
		} finally {
			delete process.env.CAST_TEST_API_KEY;
		}
	});

	it("kills a script that runs past the timeout", async () => {
		const result = await run("await new Promise(() => {});", async () => ({ content: "" }), 500);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("timed out");
	});

	it("cuts an oversized answer and says so", async () => {
		const result = await run("return 'x'.repeat(100000);", async () => ({ content: "" }));
		expect(result.content.length).toBeLessThan(23_000);
		expect(result.content).toContain("--- TRUNCATED ---");
	});

	it("reports a syntax error in the script as an error result", async () => {
		const result = await run("return (", async () => ({ content: "" }));
		expect(result.isError).toBe(true);
	});

	it("lets only a few calls run at once and queues the rest", async () => {
		let active = 0;
		let peak = 0;
		const result = await run(
			"const r = await Promise.all(Array.from({ length: 30 }, () => codemode.shop.get_order({ orderId: '1' }))); return r.length;",
			async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 10));
				active--;
				return { content: "{}" };
			},
		);
		expect(result.content.split("\n\n")[0]).toBe("30");
		expect(peak).toBe(8);
	});
});
