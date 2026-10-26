import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextReloader } from "../src/server/bridge/context-reloader.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_context_reloader__");
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	const testHome = join(TEST_DIR, "home");
	process.env.HOME = testHome;
	process.env.USERPROFILE = testHome;
	mkdirSync(testHome, { recursive: true });
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("createContextReloader", () => {
	it("waits for active turns to finish before applying a context change", async () => {
		const cwd = join(TEST_DIR, "workspace");
		mkdirSync(cwd, { recursive: true });
		let busy = true;
		const onChange = vi.fn(async () => {});
		const reloader = createContextReloader({
			isBusy: () => busy,
			onChange,
			extraPathsForCwd: () => [],
		});
		reloader.sync([cwd]);

		try {
			writeFileSync(join(cwd, "AGENTS.md"), "updated instructions\n");
			await new Promise((resolve) => setTimeout(resolve, 2_200));
			expect(onChange).not.toHaveBeenCalled();

			busy = false;
			reloader.notifyIdle();
			await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1_000 });
			expect(onChange).toHaveBeenCalledWith(cwd);
		} finally {
			reloader.dispose();
		}
	});
});
