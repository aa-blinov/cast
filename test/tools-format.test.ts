import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { detectFormatter, formatWrittenFile } from "../src/core/tools/format.ts";
import { createToolExecutor } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "format");
const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 10_000,
};

/** A stand-in formatter: collapses double spaces in the file named last. */
function fakeBin(dir: string, name: string, body = 'for f; do :; done; sed -i "s/  */ /g" "$f"') {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("auto-format", () => {
	let realHome: string | undefined;
	let realPath: string | undefined;
	beforeEach(() => {
		mkdirSync(join(TEST_DIR, ".git"), { recursive: true });
		mkdirSync(join(TEST_DIR, "home"), { recursive: true });
		realHome = process.env.HOME;
		realPath = process.env.PATH;
		process.env.HOME = join(TEST_DIR, "home");
	});
	afterEach(() => {
		process.env.HOME = realHome;
		process.env.PATH = realPath;
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("finds biome through its config and the local binary, from a nested file", () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		const biome = fakeBin(join(TEST_DIR, "node_modules", ".bin"), "biome");
		const file = join(TEST_DIR, "src", "deep", "a.ts");
		expect(detectFormatter(file)).toMatchObject({ name: "biome", command: biome, cwd: TEST_DIR });
		expect(detectFormatter(join(TEST_DIR, "notes.md"))).toBeUndefined();
	});

	it("needs the formatter installed, not just configured", () => {
		writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({ prettier: {} }));
		expect(detectFormatter(join(TEST_DIR, "a.md"))).toBeUndefined();
		fakeBin(join(TEST_DIR, "node_modules", ".bin"), "prettier");
		expect(detectFormatter(join(TEST_DIR, "a.md"))?.name).toBe("prettier");
	});

	it("uses ruff for a ruff-configured python project and gofmt for go", () => {
		const bin = join(TEST_DIR, "bin");
		fakeBin(bin, "ruff");
		fakeBin(bin, "gofmt");
		process.env.PATH = bin;
		expect(detectFormatter(join(TEST_DIR, "a.py"))).toBeUndefined();
		writeFileSync(join(TEST_DIR, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
		expect(detectFormatter(join(TEST_DIR, "a.py"))?.args).toEqual(["format", join(TEST_DIR, "a.py")]);
		expect(detectFormatter(join(TEST_DIR, "main.go"))?.name).toBe("gofmt");
	});

	it("stops at the repository root", () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		fakeBin(join(TEST_DIR, "node_modules", ".bin"), "biome");
		mkdirSync(join(TEST_DIR, "vendor", "lib", ".git"), { recursive: true });
		expect(detectFormatter(join(TEST_DIR, "vendor", "lib", "a.ts"))).toBeUndefined();
	});

	it("tells the model when the file changed, and stays quiet when it didn't or the formatter failed", async () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		const bin = join(TEST_DIR, "node_modules", ".bin");
		fakeBin(bin, "biome");
		const file = join(TEST_DIR, "a.ts");
		writeFileSync(file, "const  a =  1;\n");
		expect(await formatWrittenFile(file)).toContain("Auto-formatted with the project's formatter (biome)");
		expect(readFileSync(file, "utf-8")).toBe("const a = 1;\n");
		expect(await formatWrittenFile(file)).toBeUndefined();

		fakeBin(bin, "biome", 'echo "parse error" >&2; exit 1');
		writeFileSync(file, "const  broken = ;\n");
		expect(await formatWrittenFile(file)).toBeUndefined();
		expect(readFileSync(file, "utf-8")).toBe("const  broken = ;\n");
	});

	it("runs after write and edit, and not when autoFormat is off", async () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		fakeBin(join(TEST_DIR, "node_modules", ".bin"), "biome");
		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const written = await exec("write", { path: "a.ts", content: "let  x = 1;\n" });
		expect(written.content).toContain("Auto-formatted with the project's formatter (biome)");
		expect(readFileSync(join(TEST_DIR, "a.ts"), "utf-8")).toBe("let x = 1;\n");
		const edited = await exec("edit", { filePath: "a.ts", oldString: "let x = 1;", newString: "let  y = 2;" });
		expect(edited.content).toContain("Auto-formatted with the project's formatter (biome)");

		mkdirSync(join(TEST_DIR, "home", ".cast"), { recursive: true });
		writeFileSync(join(TEST_DIR, "home", ".cast", "settings.json"), JSON.stringify({ autoFormat: false }));
		const raw = await exec("write", { path: "b.ts", content: "let  z = 3;\n" });
		expect(raw.content).not.toContain("Auto-formatted");
		expect(readFileSync(join(TEST_DIR, "b.ts"), "utf-8")).toBe("let  z = 3;\n");
	});
});
