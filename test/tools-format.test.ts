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
function fakeBin(dir: string, name: string, fail = false) {
	mkdirSync(dir, { recursive: true });
	if (process.platform === "win32" && (name === "biome" || name === "prettier")) {
		const packageName = name === "biome" ? "@biomejs/biome" : "prettier";
		const packageDir = join(dir, "..", packageName);
		const scriptPath = join(packageDir, "bin", `${name}.cjs`);
		mkdirSync(join(packageDir, "bin"), { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ bin: { [name]: `bin/${name}.cjs` } }));
		writeFileSync(scriptPath, formatterSource(fail));
		const shim = join(dir, `${name}.cmd`);
		writeFileSync(shim, "@echo off\r\n");
		return shim;
	}
	const path = join(dir, `${name}${process.platform === "win32" ? ".exe" : ""}`);
	if (name === "biome" && process.platform !== "win32") {
		writeFileSync(path, `#!/usr/bin/env node\n${formatterSource(fail)}`);
		chmodSync(path, 0o755);
	} else {
		writeFileSync(path, "");
	}
	return path;
}

function formatterSource(fail: boolean): string {
	return fail
		? 'process.stderr.write("parse error\\n"); process.exit(1);\n'
		: 'const fs = require("node:fs"); const file = process.argv.at(-1); const text = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, text.replace(/ {2,}/g, " "));\n';
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
		const formatter = detectFormatter(file);
		expect(formatter).toMatchObject({ name: "biome", cwd: TEST_DIR });
		if (process.platform === "win32") expect(formatter?.command).toBe(process.execPath);
		else expect(formatter?.command).toBe(biome);
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

		fakeBin(bin, "biome", true);
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
