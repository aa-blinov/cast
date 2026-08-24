import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgent, deleteAgent, getAgent, listAgents, updateAgent } from "../src/core/agents.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";

let testDbDir: string;
let previousDbPath: string | undefined;

beforeEach(() => {
	previousDbPath = process.env.CAST_SESSIONS_DB;
	testDbDir = mkdtempSync(join(tmpdir(), "cast-agents-test-"));
	process.env.CAST_SESSIONS_DB = join(testDbDir, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(() => {
	resetDbConnectionForTests();
	if (previousDbPath === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = previousDbPath;
	rmSync(testDbDir, { recursive: true, force: true });
});

describe("agents", () => {
	it("creates and lists agents", () => {
		const a = createAgent({ name: "test-agent", persona: "senior", model: "MiniMax-M3" });
		expect(a.name).toBe("test-agent");
		expect(a.persona).toBe("senior");
		expect(listAgents()).toHaveLength(1);
	});

	it("rejects duplicate names", () => {
		createAgent({ name: "dup" });
		expect(() => createAgent({ name: "dup" })).toThrow(/already exists/);
	});

	it("validates name format", () => {
		expect(() => createAgent({ name: "Bad Name" })).toThrow(/lowercase/);
	});

	it("gets and deletes", () => {
		const a = createAgent({ name: "to-delete" });
		expect(getAgent(a.id)).not.toBeNull();
		expect(deleteAgent(a.id)).toBe(true);
		expect(getAgent(a.id)).toBeNull();
		expect(listAgents()).toHaveLength(0);
	});

	it("updates persona/model/provider", () => {
		const a = createAgent({ name: "upd", persona: "senior" });
		const updated = updateAgent(a.id, { persona: "analyst", model: "gpt-4o" });
		expect(updated?.persona).toBe("analyst");
		expect(updated?.model).toBe("gpt-4o");
	});

	it("pins provider/model via persona frontmatter", async () => {
		const { loadPersonas } = await import("../src/core/personas.ts");
		// use a temporary persona dir with a pinned model
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const dir = join(testDbDir, "personas");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pinned.md"),
			"---\nname: pinned\nlabel: Pinned\nmodel: gpt-4o\nprovider: openai\n---\nBody",
		);
		const personas = loadPersonas({ builtinDir: dir });
		const p = personas.find((x) => x.name === "pinned");
		expect(p?.model).toBe("gpt-4o");
		expect(p?.provider).toBe("openai");
	});
});
