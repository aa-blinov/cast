const LONG_RUNNING_PATTERNS = [
	/\b(?:python(?:3)?|pypy(?:3)?)\s+-m\s+http\.server\b/i,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch|serve)\b/i,
	/\b(?:vite|next|astro)\s+(?:dev|start)\b/i,
	/\b(?:vite|next|astro)\s+--[a-z]/i,
	/\b(?:cargo|docker)\s+watch\b/i,
	/\b(?:tail|journalctl)\b[^\n]*(?:-f|--follow)\b/i,
	/\b(?:nodemon|webpack-dev-server)\b/i,
	/\b(?:docker|podman)\s+(?:compose\s+)?up\b(?![^\n]*\s-d(?:\s|$))/i,
	/\bwhile\s+(?:true|:)\b/i,
	/\bsleep\s+(?:infinity|[0-9]{4,})\b/i,
];

/** Detect commands that are expected to keep a session open indefinitely. */
export function looksLongRunningCommand(command: string): boolean {
	return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command.replace(/\s+/g, " ").trim()));
}
