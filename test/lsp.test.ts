import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { lspStatus, resetLspForTests } from "../src/core/lsp/index.ts";
import { rootFor } from "../src/core/lsp/servers.ts";
import { createToolExecutor, getToolDefinitions } from "../src/core/tools.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

const config = {
	baseURL: "",
	apiKey: "",
	contextWindow: 128_000,
	maxResponseTokens: 1000,
	compactionThreshold: 0.8,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 10_000,
	reasoningLevel: "off",
	reasoningParams: { body: {}, enabled: false },
	reasoningFormat: "openai-compatible",
} as AppConfig;

let home = "";
let project = "";
let realHome: string | undefined;

function settings(extra: Record<string, unknown> = {}, pull = false): void {
	mkdirSync(join(home, ".cast"), { recursive: true });
	writeFileSync(
		join(home, ".cast", "settings.json"),
		JSON.stringify({
			lspAutoInstall: false,
			lspServers: {
				fake: {
					command: [process.execPath, FIXTURE],
					extensions: [".fake"],
					env: { FAKE_LSP_PULL: pull ? "1" : "0" },
				},
			},
			...extra,
		}),
	);
}

beforeEach(() => {
	realHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "cast-lsp-home-"));
	project = mkdtempSync(join(tmpdir(), "cast-lsp-project-"));
	process.env.HOME = home;
	settings();
});

afterEach(() => {
	resetLspForTests();
	process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const exec = (name: string, args: Record<string, unknown>) => createToolExecutor(project, config)(name, args);

describe.each([
	["push", false],
	["pull", true],
])("diagnostics after a change (%s server)", (_mode, pull) => {
	beforeEach(() => settings({}, pull));

	it("reports the errors a change introduces, and only counts the ones already there", async () => {
		writeFileSync(join(project, "a.fake"), "def alpha\nERR old problem\n");
		// The file is checked before the edit too: its old error isn't the edit's doing.
		const first = await exec("edit", { filePath: "a.fake", oldString: "def alpha", newString: "def alpha2" });
		expect(first.content).not.toContain("please fix");
		expect(first.content).toContain("(1 error was already in a.fake before this change.)");

		const second = await exec("edit", {
			filePath: "a.fake",
			oldString: "def alpha2",
			newString: "def alpha\nERR new problem",
		});
		expect(second.content).toContain("LSP errors introduced by this change, please fix:");
		expect(second.content).toContain("ERROR [2:1] new problem");
		// Shifted to line 3, still the same old error: counted, not listed.
		expect(second.content).not.toContain("] old problem");
		expect(second.content).toContain("(1 error was already in a.fake before this change.)");

		const fixed = await exec("edit", { filePath: "a.fake", oldString: "ERR new problem\n", newString: "" });
		expect(fixed.content).not.toContain("introduced by this change");
	});

	it("lists every error of a new file as introduced", async () => {
		const r = await exec("write", { path: "new.fake", content: "ERR fresh\n" });
		expect(r.content).toContain("LSP errors introduced by this change, please fix:");
		expect(r.content).toContain("ERROR [1:1] fresh (fake)");
	});

	it("reports another open file this change broke", async () => {
		writeFileSync(join(project, "a.fake"), "def alpha\n");
		writeFileSync(join(project, "b.fake"), "need alpha\n");
		await exec("lsp", { operation: "diagnostics", file_path: "a.fake" });
		expect((await exec("lsp", { operation: "diagnostics", file_path: "b.fake" })).content).toBe(
			"No diagnostics in b.fake.",
		);

		const result = await exec("edit", { filePath: "a.fake", oldString: "def alpha", newString: "def beta" });
		expect(result.content).toContain("This change broke other files:");
		expect(result.content).toContain('<diagnostics file="b.fake">\nERROR [1:1] alpha is not declared (fake)');
	});
});

describe("lsp tool", () => {
	beforeEach(() => {
		writeFileSync(join(project, "lib.fake"), "def total\ndef helper\n");
		writeFileSync(join(project, "main.fake"), "use total\ncall total and helper\n");
	});

	it("goes to a definition, 1-based, with the line of code", async () => {
		await exec("lsp", { operation: "documentSymbol", file_path: "lib.fake" });
		const r = await exec("lsp", { operation: "goToDefinition", file_path: "main.fake", line: 1, character: 6 });
		expect(r.content).toBe("lib.fake:1:5  def total");
	});

	it("finds references across open files", async () => {
		await exec("lsp", { operation: "documentSymbol", file_path: "main.fake" });
		const r = await exec("lsp", { operation: "findReferences", file_path: "lib.fake", line: 1, character: 5 });
		expect(r.content.split("\n")).toEqual([
			"main.fake:1:5  use total",
			"main.fake:2:6  call total and helper",
			"lib.fake:1:5  def total",
		]);
	});

	it("hovers, outlines a file, and searches symbols", async () => {
		expect((await exec("lsp", { operation: "hover", file_path: "lib.fake", line: 2, character: 6 })).content).toBe(
			"hover: helper",
		);
		expect((await exec("lsp", { operation: "documentSymbol", file_path: "lib.fake" })).content).toBe(
			"Function total (lines 1-1)\nFunction helper (lines 2-2)",
		);
		expect((await exec("lsp", { operation: "workspaceSymbol", file_path: "lib.fake", query: "help" })).content).toBe(
			"Function helper  lib.fake:2:5",
		);
		expect((await exec("lsp", { operation: "hover", file_path: "lib.fake", line: 3, character: 1 })).content).toBe(
			"No hover information.",
		);
	});

	it("rejects 0-based positions and unknown operations", async () => {
		const zero = await exec("lsp", { operation: "hover", file_path: "lib.fake", line: 0, character: 1 });
		expect(zero).toMatchObject({ isError: true, content: expect.stringContaining("1-based") });
		const bad = await exec("lsp", { operation: "rename", file_path: "lib.fake" });
		expect(bad.isError).toBe(true);
	});

	it("says when no server handles a file", async () => {
		writeFileSync(join(project, "notes.txt"), "hello");
		const r = await exec("lsp", { operation: "hover", file_path: "notes.txt", line: 1, character: 1 });
		expect(r).toMatchObject({
			isError: true,
			content: expect.stringContaining("No language server handles .txt files"),
		});
	});

	it("restarts a server that crashed", async () => {
		writeFileSync(join(project, "crash.fake"), "CRASH\n");
		await exec("lsp", { operation: "hover", file_path: "crash.fake", line: 1, character: 1 });
		await new Promise((r) => setTimeout(r, 100));
		const r = await exec("lsp", { operation: "hover", file_path: "lib.fake", line: 1, character: 6 });
		expect(r.content).toBe("hover: total");
		// Crashing on every try, it is given up on rather than restarted forever.
		for (let i = 0; i < 3; i++)
			await exec("lsp", { operation: "hover", file_path: "crash.fake", line: 1, character: 1 });
		expect(lspStatus().unavailable.find((u) => u.id === "fake")?.reason).toContain("crashed");
	});

	it("leaves a server that won't start alone, and says why", async () => {
		settings({ lspServers: { fake: { command: ["/nonexistent/lsp-server"], extensions: [".fake"] } } });
		const r = await exec("lsp", { operation: "hover", file_path: "lib.fake", line: 1, character: 6 });
		expect(r.isError).toBe(true);
		expect(lspStatus().unavailable.map((u) => u.id)).toContain("fake");
	});

	it("is not offered, and edits say nothing, when turned off", async () => {
		settings({ lsp: false });
		expect(getToolDefinitions().some((t) => t.type === "function" && t.function.name === "lsp")).toBe(false);
		writeFileSync(join(project, "a.fake"), "x\n");
		const r = await exec("edit", { filePath: "a.fake", oldString: "x", newString: "ERR y" });
		expect(r.content).not.toContain("LSP");
	});
});

describe("rootFor", () => {
	it("picks the nearest marker, and skips a strict server without one", () => {
		mkdirSync(join(project, "pkg", "src"), { recursive: true });
		writeFileSync(join(project, "pkg", "Cargo.toml"), "");
		const def = {
			id: "x",
			extensions: [".rs"],
			rootMarkers: ["Cargo.toml"],
			strictRoot: true,
			resolve: async () => undefined,
		};
		expect(rootFor(def, join(project, "pkg", "src", "main.rs"), project)).toBe(join(project, "pkg"));
		expect(rootFor(def, join(project, "other.rs"), project)).toBeUndefined();
		expect(rootFor({ ...def, strictRoot: false }, join(project, "other.rs"), project)).toBe(project);
	});
});
