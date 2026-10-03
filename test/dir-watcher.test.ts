import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DirChange, watchDirectories } from "../src/server/bridge/dir-watcher.ts";

let root = "";
let changes: { kind: DirChange; path: string }[] = [];
const open: { close: () => void }[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function start(initial: string[], isIgnored: (path: string) => boolean = () => false, max?: number) {
	const watcher = watchDirectories(
		root,
		initial,
		isIgnored,
		(kind, path) => changes.push({ kind, path }),
		() => {},
		max,
	);
	open.push(watcher);
	return watcher;
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await sleep(25);
	}
	return check();
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cast-dirwatch-")));
	changes = [];
});

afterEach(() => {
	for (const watcher of open.splice(0)) watcher.close();
	rmSync(root, { recursive: true, force: true });
});

describe("watchDirectories", () => {
	it("sees a file changed in the root and in a listed subfolder", async () => {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "a.txt"), "1");
		writeFileSync(join(root, "src", "b.txt"), "1");
		start([join(root, "src")]);
		writeFileSync(join(root, "a.txt"), "2");
		writeFileSync(join(root, "src", "b.txt"), "2");
		expect(
			await until(
				() => changes.some((c) => c.path.endsWith("a.txt")) && changes.some((c) => c.path.endsWith("b.txt")),
			),
		).toBe(true);
	});

	it("reports a new folder and then sees files inside it, however deep", async () => {
		start([]);
		mkdirSync(join(root, "new", "deep"), { recursive: true });
		expect(await until(() => changes.some((c) => c.kind === "addDir" && c.path === join(root, "new")))).toBe(true);
		await sleep(300);
		writeFileSync(join(root, "new", "deep", "c.txt"), "x");
		expect(await until(() => changes.some((c) => c.path.endsWith("c.txt")))).toBe(true);
	});

	it("skips ignored folders, as listed and as they appear", async () => {
		mkdirSync(join(root, "skipme"));
		const watcher = start([join(root, "skipme")], (path) => path.includes("skipme"));
		expect(watcher.size()).toBe(1);
		mkdirSync(join(root, "skipme", "inner"));
		writeFileSync(join(root, "skipme", "x.txt"), "x");
		await sleep(600);
		expect(changes).toEqual([]);
	});

	it("survives a watched folder being deleted", async () => {
		mkdirSync(join(root, "gone"));
		const watcher = start([join(root, "gone")]);
		expect(watcher.size()).toBe(2);
		rmSync(join(root, "gone"), { recursive: true });
		expect(await until(() => changes.length > 0)).toBe(true);
		expect(await until(() => watcher.size() === 1)).toBe(true);
		writeFileSync(join(root, "still.txt"), "x");
		expect(await until(() => changes.some((c) => c.path.endsWith("still.txt")))).toBe(true);
	});

	it("stops adding watches at the cap", async () => {
		const dirs = Array.from({ length: 20 }, (_, i) => join(root, `d${i}`));
		for (const dir of dirs) mkdirSync(dir);
		expect(start(dirs, () => false, 5).size()).toBe(5);
	});

	// A change is reported only after a stat says whether it is a file or a folder, and that answer can come back after
	// close(). Closing from inside the ignore check is a way to land exactly between the event and its answer.
	it("reports nothing for an event that was in flight when it was closed", async () => {
		const target = join(root, "late.txt");
		const w = watchDirectories(
			root,
			[],
			(path) => {
				if (path === target) w.close();
				return false;
			},
			(kind, path) => changes.push({ kind, path }),
			() => {},
		);
		open.push(w);
		writeFileSync(target, "x");
		await sleep(500);
		expect(changes).toEqual([]);
	});

	it("stops reporting once closed", async () => {
		const watcher = start([]);
		watcher.close();
		writeFileSync(join(root, "late.txt"), "x");
		await sleep(500);
		expect(changes).toEqual([]);
		expect(watcher.size()).toBe(0);
	});
});
