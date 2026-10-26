import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Settings } from "../../src/core/settings.ts";

export interface TestEnvironment {
	root: string;
	home: string;
	cwd: string;
	castDir: string;
	projectCastDir: string;
	dbPath: string;
	settingsPath: string;
}

/** Create the filesystem boundary used by one isolated test. */
export function createTestEnvironment(prefix = "cast-test-"): TestEnvironment {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const home = join(root, "home");
	const cwd = join(home, "workspace");
	const castDir = join(home, ".cast");
	const projectCastDir = join(cwd, ".cast");
	mkdirSync(join(castDir, "sessions"), { recursive: true });
	mkdirSync(projectCastDir, { recursive: true });
	return {
		root,
		home,
		cwd,
		castDir,
		projectCastDir,
		dbPath: join(castDir, "sessions.db"),
		settingsPath: join(castDir, "settings.json"),
	};
}

export function applyTestEnvironment(environment: TestEnvironment): void {
	setTestHome(environment.home);
	process.env.CAST_CWD = environment.cwd;
	process.env.CAST_SESSIONS_DB = environment.dbPath;
}

export function setTestHome(home: string): void {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	if (process.platform === "win32") {
		const root = win32.parse(home).root;
		process.env.HOMEDRIVE = root.slice(0, 2);
		process.env.HOMEPATH = home.slice(root.length) || "\\";
	}
}

export function testHomeEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base, HOME: home, USERPROFILE: home };
	if (process.platform === "win32") {
		const root = win32.parse(home).root;
		env.HOMEDRIVE = root.slice(0, 2);
		env.HOMEPATH = home.slice(root.length) || "\\";
	}
	return env;
}

export function writeTestSettings(environment: TestEnvironment, settings: Partial<Settings>): void {
	writeFileSync(environment.settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

export function destroyTestEnvironment(environment: TestEnvironment): void {
	rmSync(environment.root, { recursive: true, force: true });
}
