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
