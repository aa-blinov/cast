import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backupFileForCheckpoint,
	createCheckpoint,
	filesLostByRestore,
	releaseCheckpointRefs,
	restoreCheckpoint,
} from "../src/core/checkpoint.ts";
import {
	createShadowSnapshot,
	fitsInSnapshot,
	MAX_SNAPSHOT_FILES,
	releaseShadowRefs,
} from "../src/core/shadow-snapshot.ts";

let home = "";
let project = "";
let previousHome: string | undefined;

beforeEach(() => {
	previousHome = process.env.HOME;
	home = realpathSync(mkdtempSync(join(tmpdir(), "cast-shadow-home-")));
	project = realpathSync(mkdtempSync(join(tmpdir(), "cast-shadow-proj-")));
	// The hidden repositories go under ~/.cast/shadow: keep that in a temp dir.
	process.env.HOME = home;
	writeFileSync(join(project, "a.txt"), "A0\n");
	writeFileSync(join(project, "b.txt"), "B0\n");
	writeFileSync(join(project, "gone.txt"), "G0\n");
	mkdirSync(join(project, "sub"));
	writeFileSync(join(project, "sub", "c.txt"), "C0\n");
	mkdirSync(join(project, "node_modules"));
	writeFileSync(join(project, "node_modules", "dep.js"), "dep0\n");
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("snapshots of a folder that is not a git repository", () => {
	it("undoes what a shell command changed, deleted and created", async () => {
		const chk = await createCheckpoint(project);
		expect(chk.shadowDir).toBeDefined();
		expect(chk.shadowDir?.startsWith(join(home, ".cast", "shadow"))).toBe(true);

		// No backup hook runs for any of these: this is what bash does.
		writeFileSync(join(project, "b.txt"), "B-by-shell\n");
		rmSync(join(project, "gone.txt"));
		writeFileSync(join(project, "made.txt"), "new\n");
		mkdirSync(join(project, "newdir"));
		writeFileSync(join(project, "newdir", "x.txt"), "x");

		const res = await restoreCheckpoint(chk);
		expect(res.ok).toBe(true);
		expect(res.message).toContain("snapshot");
		expect(readFileSync(join(project, "b.txt"), "utf8")).toBe("B0\n");
		expect(existsSync(join(project, "gone.txt"))).toBe(true);
		expect(existsSync(join(project, "made.txt"))).toBe(false);
		expect(existsSync(join(project, "newdir"))).toBe(false);
	});

	it("leaves dependency and build folders alone", async () => {
		const chk = await createCheckpoint(project);
		writeFileSync(join(project, "node_modules", "dep.js"), "dep-changed\n");
		writeFileSync(join(project, "node_modules", "added.js"), "x");
		await restoreCheckpoint(chk);
		expect(readFileSync(join(project, "node_modules", "dep.js"), "utf8")).toBe("dep-changed\n");
		expect(existsSync(join(project, "node_modules", "added.js"))).toBe(true);
	});

	it("restores one turn at a time, newest first", async () => {
		const first = await createCheckpoint(project);
		writeFileSync(join(project, "a.txt"), "A1\n");
		const second = await createCheckpoint(project);
		writeFileSync(join(project, "a.txt"), "A2\n");

		expect((await restoreCheckpoint(second)).ok).toBe(true);
		expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("A1\n");
		expect((await restoreCheckpoint(first)).ok).toBe(true);
		expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("A0\n");
	});

	it("names the files created since the checkpoint, and only those", async () => {
		const chk = await createCheckpoint(project);
		expect(await filesLostByRestore(chk)).toEqual([]);
		writeFileSync(join(project, "a.txt"), "A1\n");
		expect(await filesLostByRestore(chk)).toEqual([]);
		writeFileSync(join(project, "made.txt"), "new\n");
		expect(await filesLostByRestore(chk)).toEqual(["made.txt"]);
	});

	it("also restores what the edit tools backed up", async () => {
		const chk = await createCheckpoint(project);
		backupFileForCheckpoint(chk, join(project, "a.txt"));
		writeFileSync(join(project, "a.txt"), "A1\n");
		expect((await restoreCheckpoint(chk)).ok).toBe(true);
		expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("A0\n");
	});

	it("deletes the hidden repository with the last checkpoint, even after the folder is gone", async () => {
		const first = await createCheckpoint(project);
		const second = await createCheckpoint(project);
		const shadowDir = first.shadowDir as string;
		await releaseCheckpointRefs([first]);
		expect(existsSync(shadowDir)).toBe(true);
		// A deleted sandbox session: its folder is removed before the refs are.
		rmSync(project, { recursive: true, force: true });
		await releaseCheckpointRefs([second]);
		expect(existsSync(shadowDir)).toBe(false);
	});

	it("undoes back to an empty folder, the state of a fresh sandbox at its first turn", async () => {
		const fresh = join(project, "fresh");
		mkdirSync(fresh);
		const chk = await createCheckpoint(fresh);
		expect(chk.shadowDir).toBeDefined();
		writeFileSync(join(fresh, "made.txt"), "x");
		mkdirSync(join(fresh, "d"));
		writeFileSync(join(fresh, "d", "y.txt"), "y");

		const res = await restoreCheckpoint(chk);
		expect(res.ok).toBe(true);
		expect(readdirSync(fresh)).toEqual([]);
	});

	it("does not snapshot a folder over the file limit, and falls back to per-file backups", async () => {
		const big = join(project, "big");
		mkdirSync(big);
		for (let i = 0; i <= MAX_SNAPSHOT_FILES; i++) writeFileSync(join(big, `f${i}`), "");
		expect(await fitsInSnapshot(project)).toBe(false);
		const chk = await createCheckpoint(project);
		expect(chk.shadowDir).toBeUndefined();
		expect(chk.gitCommitSha).toBeUndefined();

		writeFileSync(join(project, "b.txt"), "B-by-shell\n");
		const res = await restoreCheckpoint(chk);
		expect(res.message).toContain("too big to snapshot");
		expect(readFileSync(join(project, "b.txt"), "utf8")).toBe("B-by-shell\n");
	});

	it("never snapshots the home directory or the filesystem root", async () => {
		expect(await fitsInSnapshot(home)).toBe(false);
		expect(await fitsInSnapshot("/")).toBe(false);
		expect((await createCheckpoint(home)).shadowDir).toBeUndefined();
		expect(existsSync(join(home, ".cast", "shadow")) ? readdirSync(join(home, ".cast", "shadow")) : []).toEqual([]);
	});
});

describe("concurrent use of one folder's hidden repository", () => {
	it("keeps a checkpoint written while another session releases the repository", async () => {
		let lost = 0;
		let thrown = 0;
		let broken = 0;
		for (let round = 0; round < 40; round++) {
			const first = await createShadowSnapshot(project, `old-${round}`);
			if (!first) {
				broken++;
				continue;
			}
			// One session drops its last ref (and deletes the repository when nothing else is pinned) while another
			// takes a checkpoint in the same folder.
			const [released, second] = await Promise.all([
				releaseShadowRefs(first.shadowDir, [`old-${round}`]).then(
					() => true,
					() => false,
				),
				createShadowSnapshot(project, `new-${round}`),
			]);
			if (!released) thrown++;
			if (!second) continue;
			const exists = spawnSync("git", ["--git-dir", second.shadowDir, "cat-file", "-e", second.commitSha]);
			if (exists.status !== 0) lost++;
		}
		expect({ lost, thrown, broken }).toEqual({ lost: 0, thrown: 0, broken: 0 });
	}, 60_000);
});
