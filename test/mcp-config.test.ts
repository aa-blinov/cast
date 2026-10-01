import { describe, expect, it } from "vitest";
import { isMcpConfigPath } from "../src/core/mcp-config.ts";

describe("isMcpConfigPath", () => {
	it("recognises the global and the project MCP config", () => {
		expect(isMcpConfigPath("/home/ubuntu/.cast/mcp.json")).toBe(true);
		expect(isMcpConfigPath("/work/app/.cast/mcp.json")).toBe(true);
		expect(isMcpConfigPath(".cast/mcp.json")).toBe(true);
		expect(isMcpConfigPath("C:\\Users\\me\\.cast\\mcp.json")).toBe(true);
	});

	it("leaves other files, and anything that is not a path, alone", () => {
		expect(isMcpConfigPath("/work/app/mcp.json")).toBe(false);
		expect(isMcpConfigPath("/home/ubuntu/.cast/settings.json")).toBe(false);
		expect(isMcpConfigPath("/work/.castx/mcp.json")).toBe(false);
		expect(isMcpConfigPath(undefined)).toBe(false);
		expect(isMcpConfigPath(42)).toBe(false);
	});
});
