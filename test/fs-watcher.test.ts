import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsWatcher } from "../src/server/bridge/fs-watcher.ts";
import type { WebAgentSession, WebEvent } from "../src/server/bridge.ts";

let root = "";
let events: WebEvent[] = [];

function watcherFor(cwd: string) {
	const ws = {
		id: "s1",
		status: "idle",
		listeners: new Set([() => {}]),
		session: { cwd },
	} as unknown as WebAgentSession;
	const sessions = new Map([["s1", ws]]);
	const watcher = createFsWatcher({
		sessions,
		cwd,
		trustForSessionCwd: () => false,
		broadcast: (_ws, event) => events.push(event),
		onIdle: () => {},
	});
	return { ws, watcher };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Touches a file until the watcher has noticed something, since chokidar gives no ready signal here. */
async function changesSeenAfterTouching(path: string, waitMs = 4500): Promise<number> {
	events = [];
	const deadline = Date.now() + waitMs;
	let n = 0;
	while (Date.now() < deadline && events.length === 0) {
		writeFileSync(path, `${n++}`);
		// Longer than the watcher's 500ms debounce: a write that lands inside the
		// window restarts it, so a faster loop would never let it fire.
		await sleep(900);
	}
	return events.length;
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "cast-fswatch-")));
	events = [];
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), "work/\n");
	mkdirSync(join(root, "work", "deep"), { recursive: true });
	writeFileSync(join(root, "work", "deep", "x.txt"), "x");
	writeFileSync(join(root, "tracked.txt"), "t");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("idle file watcher", () => {
	it("reports a change in the project and stays quiet about git-ignored folders", async () => {
		const { ws, watcher } = watcherFor(root);
		watcher.startFsWatcher(ws);
		try {
			expect(await changesSeenAfterTouching(join(root, "tracked.txt"))).toBeGreaterThan(0);
			expect(await changesSeenAfterTouching(join(root, "work", "deep", "x.txt"), 2500)).toBe(0);
		} finally {
			watcher.stopFsWatcher(ws.id);
		}
	});

	it("does not start a watcher that was stopped while it was still starting", async () => {
		const { ws, watcher } = watcherFor(root);
		watcher.startFsWatcher(ws);
		watcher.stopFsWatcher(ws.id);
		expect(await changesSeenAfterTouching(join(root, "tracked.txt"), 1500)).toBe(0);
	});

	it("starts only one watcher for repeated starts", async () => {
		const { ws, watcher } = watcherFor(root);
		watcher.startFsWatcher(ws);
		watcher.startFsWatcher(ws);
		try {
			await changesSeenAfterTouching(join(root, "tracked.txt"));
			await sleep(700);
			expect(events.length).toBe(1);
		} finally {
			watcher.stopFsWatcher(ws.id);
		}
	});
});
