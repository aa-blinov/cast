const MCP_CONFIG_PATH_RE = /(?:^|\/)\.cast\/mcp\.json$/;

/** Whether a path is a cast MCP config: `~/.cast/mcp.json` or a project's `.cast/mcp.json`. */
export function isMcpConfigPath(path: unknown): boolean {
	return typeof path === "string" && MCP_CONFIG_PATH_RE.test(path.replaceAll("\\", "/"));
}
