import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { loadSettings } from "../src/core/settings.ts";
import {
	applyTestEnvironment,
	createTestEnvironment,
	destroyTestEnvironment,
	type TestEnvironment,
	writeTestSettings,
} from "./helpers/test-environment.ts";

let environments: TestEnvironment[] = [];

afterEach(() => {
	for (const environment of environments) destroyTestEnvironment(environment);
	environments = [];
});

describe("test environment", () => {
	it("creates independent home, project cwd, settings, and database paths", () => {
		const first = createTestEnvironment();
		const second = createTestEnvironment();
		environments = [first, second];

		expect(first.root).not.toBe(second.root);
		expect(first.cwd).not.toBe(second.cwd);
		expect(first.dbPath).not.toBe(second.dbPath);
		expect(first.settingsPath).not.toBe(second.settingsPath);
		expect(existsSync(first.projectCastDir)).toBe(true);
		expect(existsSync(first.castDir)).toBe(true);
	});

	it("applies a test cwd and database and writes a controlled settings fixture", () => {
		const environment = createTestEnvironment();
		environments = [environment];
		applyTestEnvironment(environment);
		writeTestSettings(environment, { model: "fixture-model", cwd: environment.cwd });

		expect(process.env.HOME).toBe(environment.home);
		expect(process.env.CAST_CWD).toBe(environment.cwd);
		expect(process.env.CAST_SESSIONS_DB).toBe(environment.dbPath);
		expect(loadSettings()).toMatchObject({ model: "fixture-model", cwd: environment.cwd });
		expect(JSON.parse(readFileSync(environment.settingsPath, "utf-8"))).toEqual({
			model: "fixture-model",
			cwd: environment.cwd,
		});
	});

	it("creates parent directories for a custom database path", () => {
		const environment = createTestEnvironment();
		environments = [environment];
		const customDbPath = join(environment.root, "nested", "database", "sessions.db");
		process.env.CAST_SESSIONS_DB = customDbPath;
		resetDbConnectionForTests();

		getDb().prepare("SELECT 1").get();

		expect(existsSync(customDbPath)).toBe(true);
	});
});
