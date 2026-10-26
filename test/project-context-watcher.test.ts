import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectContextFiles } from "../src/core/context-files.ts";
import { watchProjectContextFiles } from "../src/core/project-context-watcher.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_project_context_watcher__");
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function waitForChange(listeners: Array<() => void>): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			listeners.splice(listeners.indexOf(listener), 1);
			reject(new Error("Timed out waiting for a context-file change"));
		}, 4_000);
		const listener = () => {
			clearTimeout(timeout);
			listeners.splice(listeners.indexOf(listener), 1);
			resolve();
		};
		listeners.push(listener);
	});
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	const testHome = join(TEST_DIR, "home");
	process.env.HOME = testHome;
	process.env.USERPROFILE = testHome;
	mkdirSync(testHome, { recursive: true });
});

afterEach(() => {
	process.env.HOME = originalHome;
	process.env.USERPROFILE = originalUserProfile;
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("watchProjectContextFiles", () => {
	it("detects creation, edits, and deletion of AGENTS.md", async () => {
		const cwd = join(TEST_DIR, "workspace");
		mkdirSync(cwd, { recursive: true });
		const contextPath = join(cwd, "AGENTS.md");
		const listeners: Array<() => void> = [];
		const stop = watchProjectContextFiles(cwd, () => {
			for (const listener of [...listeners]) listener();
		});

		try {
			const created = waitForChange(listeners);
			writeFileSync(contextPath, "first version\n");
			await created;
			expect(loadProjectContextFiles(cwd, true).find((file) => file.path === contextPath)?.content).toBe(
				"first version\n",
			);

			const edited = waitForChange(listeners);
			writeFileSync(contextPath, "second version\n");
			await edited;
			expect(loadProjectContextFiles(cwd, true).find((file) => file.path === contextPath)?.content).toBe(
				"second version\n",
			);

			const removed = waitForChange(listeners);
			rmSync(contextPath);
			await removed;
			expect(loadProjectContextFiles(cwd, true).some((file) => file.path === contextPath)).toBe(false);
		} finally {
			stop();
		}
	});

	it("detects edits to skills and MCP configuration", async () => {
		const cwd = join(TEST_DIR, "workspace");
		const skillFile = join(cwd, ".cast", "skills", "sample", "SKILL.md");
		const mcpFile = join(cwd, ".cast", "mcp.json");
		mkdirSync(join(cwd, ".cast", "skills", "sample"), { recursive: true });
		writeFileSync(skillFile, "---\nname: sample\ndescription: first\n---\n");
		writeFileSync(mcpFile, '{"mcpServers":{}}\n');
		const listeners: Array<() => void> = [];
		const stop = watchProjectContextFiles(cwd, () => {
			for (const listener of [...listeners]) listener();
		});

		try {
			const skillEdit = waitForChange(listeners);
			writeFileSync(skillFile, "---\nname: sample\ndescription: updated\n---\n");
			await skillEdit;

			const configEdit = waitForChange(listeners);
			writeFileSync(mcpFile, '{"mcpServers":{"example":{}}}\n');
			await configEdit;
		} finally {
			stop();
		}
	});
});
