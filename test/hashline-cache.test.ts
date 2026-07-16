import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { clearHashlineCache, getCachedFile, hashlineCacheSize } from "../src/core/tools/hashline-cache.ts";
import { createToolExecutor } from "../src/core/tools.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "hashline-cache");

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 10,
};

beforeEach(() => {
	// mkdtempSync analogue: rely on beforeEach mkdir in other tests, but
	// here we need a fresh cache per test to avoid cross-pollution.
	clearHashlineCache();
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	clearHashlineCache();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("hashline-cache", () => {
	it("serves a second read of the same file from the LRU", async () => {
		writeFileSync(join(TEST_DIR, "a.txt"), "one\ntwo\nthree\n");

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		const r1 = await exec("read", { path: "a.txt" });
		expect(r1.isError).toBeFalsy();
		const sizeAfterFirst = hashlineCacheSize();
		expect(sizeAfterFirst).toBe(1);

		// A second read on the same path should not grow the cache.
		const r2 = await exec("read", { path: "a.txt" });
		expect(r2.isError).toBeFalsy();
		expect(hashlineCacheSize()).toBe(1);
		expect(r1.content).toBe(r2.content);
	});

	it("invalidates the cache when the file's mtime changes (external edit)", async () => {
		const path = join(TEST_DIR, "b.txt");
		writeFileSync(path, "one\ntwo\nthree\n");
		const abs = await getCachedFile(path);
		const firstHashes = abs.hashes.map((h) => h[0]);

		// Rewrite with a tiny mtime bump so cache.get sees a new stat.
		// utimesSync is sync but `await getCachedFile` re-stats on hit —
		// the bumped mtime must drop the entry.
		const futureMs = (Date.now() + 10_000) * 1000;
		writeFileSync(path, "alpha\nbeta\ngamma\n");
		utimesSync(path, new Date(), new Date(futureMs / 1000));

		const second = await getCachedFile(path);
		expect(second.lines[0]).toBe("alpha");
		// Different content → different hashes.
		expect(second.hashes[0]![0]).not.toBe(firstHashes[0]);
	});

	it("invalidates on internal write/edit so a follow-up read sees the new file", async () => {
		const path = join(TEST_DIR, "c.txt");
		writeFileSync(path, "first\n");
		await getCachedFile(path); // warm cache

		const exec = createToolExecutor(TEST_DIR, mockConfig);
		await exec("write", { path: "c.txt", content: "second\nthird\n" });

		// The write hook must have dropped the cache entry, so the next
		// read sees the new content rather than the old cached "first\n".
		const cached = await getCachedFile(path);
		expect(cached.raw).toBe("second\nthird\n");
	});

	it("evicts the least-recently-used entry past the capacity", async () => {
		// Default capacity is 20; insert 21 and the oldest should drop.
		// We use unique filenames so the keys are unique.
		for (let i = 0; i < 21; i++) {
			writeFileSync(join(TEST_DIR, `f${i}.txt`), `line ${i}\n`);
		}
		for (let i = 0; i < 21; i++) {
			await getCachedFile(join(TEST_DIR, `f${i}.txt`));
		}
		expect(hashlineCacheSize()).toBe(20);

		// The first file should have been evicted; reading it again must
		// go back through `readFile`, not serve a stale entry.
		const fresh = await getCachedFile(join(TEST_DIR, "f0.txt"));
		expect(fresh.raw).toBe("line 0\n");
	});

	it("falls back gracefully when a file disappears between read and use", async () => {
		const path = join(TEST_DIR, "vanish.txt");
		writeFileSync(path, "x\n");
		await getCachedFile(path);
		rmSync(path);

		await expect(getCachedFile(path)).rejects.toThrow();
	});
});
