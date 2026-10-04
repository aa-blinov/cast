import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { fetchModels } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { formatDoctor, runDoctor } from "../src/core/doctor.ts";

vi.mock("../src/core/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/config.ts")>()),
	fetchModels: vi.fn(),
}));

const config = { baseURL: "https://example.test/v1", apiKey: "k" } as AppConfig;
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-doctor-test-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
	vi.mocked(fetchModels).mockReset();
});

afterEach(() => {
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

const find = (checks: { name: string }[], name: string) =>
	checks.find((c) => c.name === name) as { status: string; detail: string };

describe("runDoctor", () => {
	it("is all good when the provider answers with the model, and says so", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "m-1" }] } as never);
		const checks = await runDoctor({ config, model: "m-1", cwd: root });
		expect(find(checks, "Provider").status).toBe("ok");
		expect(find(checks, "Sessions database").status).toBe("ok");
		expect(find(checks, "Node").status).toBe("ok");
	});

	it("names a provider that does not answer, and a model the provider does not list", async () => {
		vi.mocked(fetchModels).mockResolvedValue({
			ok: false,
			error: "Connection to https://example.test/v1 timed out",
		} as never);
		expect(find(await runDoctor({ config, model: "m-1", cwd: root }), "Provider").detail).toContain("timed out");
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "other" }] } as never);
		const model = find(await runDoctor({ config, model: "m-1", cwd: root }), "Model");
		expect(model.status).toBe("fail");
		expect(model.detail).toContain("m-1 is not among the 1 models");
	});

	it("reports an MCP server that did not come up with its reason, and one that did", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "m" }] } as never);
		const checks = await runDoctor({
			config,
			model: "m",
			cwd: root,
			mcp: {
				allServerNames: ["up", "down", "never"],
				connections: [
					{ serverName: "up", alive: true },
					{ serverName: "down", alive: false, deadReason: "exited with code 1" },
				],
				diagnostics: ['mcp server "never": spawn nope ENOENT'],
			},
		});
		expect(find(checks, "MCP up").status).toBe("ok");
		expect(find(checks, "MCP down").detail).toBe("exited with code 1");
		expect(find(checks, "MCP never").detail).toBe("spawn nope ENOENT");
	});
});

describe("formatDoctor", () => {
	it("ends with a verdict that counts failures and warnings", () => {
		expect(formatDoctor([{ status: "ok", name: "a", detail: "fine" }])).toBe("[ok] a: fine\n\nAll good.");
		const text = formatDoctor([
			{ status: "fail", name: "a", detail: "x" },
			{ status: "warn", name: "b", detail: "y" },
		]);
		expect(text).toContain("[fail] a: x\n[warn] b: y");
		expect(text.endsWith("1 failed, 1 warnings.")).toBe(true);
	});
});
