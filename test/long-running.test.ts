import { describe, expect, it } from "vitest";
import { looksLongRunningCommand } from "../src/core/tools/long-running.ts";

describe("looksLongRunningCommand", () => {
	it.each([
		"python3 -m http.server 8000",
		"npm run dev",
		"cd app && vite --host 0.0.0.0",
		"tail -f server.log",
		"docker compose up",
		"while true; do sleep 1; done",
	])("recognizes %s", (command) => {
		expect(looksLongRunningCommand(command)).toBe(true);
	});

	it.each(["npm test", "npm run build", "docker compose up -d", "echo --watch complete", "sleep 10"])(
		"does not classify %s as an open-ended session",
		(command) => {
			expect(looksLongRunningCommand(command)).toBe(false);
		},
	);
});
