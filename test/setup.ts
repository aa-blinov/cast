import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { stopSqliteReader } from "../src/core/sqlite-reader.ts";
import {
	applyTestEnvironment,
	createTestEnvironment,
	destroyTestEnvironment,
	type TestEnvironment,
} from "./helpers/test-environment.ts";

const originalEnvironment = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	HOMEDRIVE: process.env.HOMEDRIVE,
	HOMEPATH: process.env.HOMEPATH,
	CAST_CWD: process.env.CAST_CWD,
	CAST_SESSIONS_DB: process.env.CAST_SESSIONS_DB,
};
const gitConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
const gitConfigIndex = Number.isSafeInteger(gitConfigCount) && gitConfigCount >= 0 ? gitConfigCount : 0;
const gitConfigKeyName = `GIT_CONFIG_KEY_${gitConfigIndex}`;
const gitConfigValueName = `GIT_CONFIG_VALUE_${gitConfigIndex}`;
const originalGitConfig = {
	count: process.env.GIT_CONFIG_COUNT,
	key: process.env[gitConfigKeyName],
	value: process.env[gitConfigValueName],
};
// The suite overrides HOME to isolate user data. Windows' os.homedir() only
// reads USERPROFILE, so mirror that POSIX test convention in this process.
const realHomedir = os.homedir.bind(os);
os.homedir = () => process.env.HOME || realHomedir();
syncBuiltinESMExports();
// Default CAST_SESSIONS_DB to a tmpdir path so background work that
// outlives its test (the AgentActorRegistry singleton's watchdog timer,
// started once by test/web-bridge.test.ts via src/core/actors.ts) has a
// safe place to land when it eventually fires. src/core/db.ts's safety
// guard otherwise refuses to open the real ~/.cast/sessions/sessions.db
// from a test process. CI sets the same env var explicitly; this default
// covers local runs where the developer didn't.
if (!process.env.CAST_SESSIONS_DB) {
	process.env.CAST_SESSIONS_DB = join(tmpdir(), "cast-test-sessions.db");
	originalEnvironment.CAST_SESSIONS_DB = process.env.CAST_SESSIONS_DB;
}
// A read or an edit starts the file's language server, and may install one
// (npm, go install, a GitHub download): never from the suite. test/lsp.test.ts
// turns it back on against its own fake server.
process.env.CAST_LSP = "off";
let testEnvironment: TestEnvironment | undefined;

beforeEach(() => {
	testEnvironment = createTestEnvironment();
	applyTestEnvironment(testEnvironment);
	process.env.GIT_CONFIG_COUNT = String(gitConfigIndex + 1);
	process.env[gitConfigKeyName] = "core.autocrlf";
	process.env[gitConfigValueName] = "false";
	resetDbConnectionForTests();
});

afterEach(async () => {
	// Windows cannot remove a test database while the read-only worker still holds its WAL handles.
	await stopSqliteReader();
	resetDbConnectionForTests();
	if (testEnvironment) destroyTestEnvironment(testEnvironment);
	testEnvironment = undefined;
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (originalGitConfig.count === undefined) delete process.env.GIT_CONFIG_COUNT;
	else process.env.GIT_CONFIG_COUNT = originalGitConfig.count;
	if (originalGitConfig.key === undefined) delete process.env[gitConfigKeyName];
	else process.env[gitConfigKeyName] = originalGitConfig.key;
	if (originalGitConfig.value === undefined) delete process.env[gitConfigValueName];
	else process.env[gitConfigValueName] = originalGitConfig.value;
});
