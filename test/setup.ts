import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	applyTestEnvironment,
	createTestEnvironment,
	destroyTestEnvironment,
	type TestEnvironment,
} from "./helpers/test-environment.ts";

const originalEnvironment = {
	HOME: process.env.HOME,
	CAST_CWD: process.env.CAST_CWD,
	CAST_SESSIONS_DB: process.env.CAST_SESSIONS_DB,
};
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
let testEnvironment: TestEnvironment | undefined;

beforeEach(() => {
	testEnvironment = createTestEnvironment();
	applyTestEnvironment(testEnvironment);
	resetDbConnectionForTests();
});

afterEach(() => {
	resetDbConnectionForTests();
	if (testEnvironment) destroyTestEnvironment(testEnvironment);
	testEnvironment = undefined;
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
