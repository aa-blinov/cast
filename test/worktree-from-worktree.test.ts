/**
 * `/worktree` semantics when the session cwd is *already* a worktree.
 *
 * The runner should not create the new worktree inside the current
 * worktree (which would produce a "linked worktree of a worktree" —
 * an orphan the main repo's `git worktree prune` would never see).
 * `findCanonicalGitRoot` walks up to the main repo's worktrees dir,
 * so the new worktree lands there.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpRoot: string | undefined;
let outerRepo: string | undefined;
let innerRepo: string | undefined;
let mockServer: Server | undefined;
let mockPort = 0;

const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), "cast-wt-from-wt-"));
	outerRepo = join(tmpRoot, "outer");
	innerRepo = join(tmpRoot, "outer", ".cast", "worktrees", "inner");
	mkdirSync(outerRepo);
	execFileSync("git", ["init", "--initial-branch=main", "-q"], { cwd: outerRepo });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: outerRepo });
	execFileSync("git", ["config", "user.name", "T"], { cwd: outerRepo });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: outerRepo });
	writeFileSync(join(outerRepo, "x"), "y\n");
	execFileSync("git", ["add", "."], { cwd: outerRepo });
	execFileSync("git", ["commit", "-m", "init"], { cwd: outerRepo });

	// Pre-create an inner worktree that the test will then start from,
	// simulating "I already did /worktree inner, now I want /worktree nested".
	execFileSync("git", ["worktree", "add", "-B", "cast-inner", innerRepo, "HEAD"], {
		cwd: outerRepo,
	});

	mockServer = createServer((req, res) => {
		if (req.url?.startsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "noop", owned_by: "test", context_window: 4096 }],
				}),
			);
		} else if (req.url?.startsWith("/v1/chat/completions")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "mock",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve) => {
		mockServer!.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = mockServer.address();
	if (addr && typeof addr === "object") mockPort = addr.port;
});

afterEach(async () => {
	if (mockServer) {
		await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
	}
	await stopTestDaemon();
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** The runner attaches to a detached daemon; stop it before deleting its fake HOME. */
async function stopTestDaemon(): Promise<void> {
	if (!tmpRoot) return;
	const statePath = join(tmpRoot, "home", ".cast", "server.json");
	if (!existsSync(statePath)) return;
	let pid: number;
	try {
		pid = (JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number }).pid ?? 0;
	} catch {
		return;
	}
	if (!pid || pid === process.pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function runInteractive(
	commands: Array<Record<string, unknown>>,
	cwd: string,
): Promise<Array<Record<string, unknown>>> {
	const fakeHome = join(tmpRoot!, "home");
	const env = { ...process.env, HOME: fakeHome, CAST_CWD: "" };
	const settingsDir = join(fakeHome, ".cast");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(
		join(settingsDir, "settings.json"),
		JSON.stringify({
			model: "noop",
			persona: "assistant",
			reasoningLevel: "off",
			providerUrl: `http://127.0.0.1:${mockPort}/v1`,
			apiKey: "test-key",
			providers: [{ name: "test", url: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key" }],
		}),
	);
	return new Promise((resolve, reject) => {
		const child = spawn("node", [DIST_ENTRY, "run", "--interactive", "--format", "json"], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", () => {
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			const lines = out.split("\n").filter((l) => l.startsWith("{"));
			if (lines.length === 0) {
				reject(new Error(`no JSONL events received from child\nstderr=\n${err}\nstdout=\n${out}`));
				return;
			}
			try {
				resolve(lines.map((l) => JSON.parse(l) as Record<string, unknown>));
			} catch (e) {
				reject(new Error(`failed to parse JSONL: ${(e as Error).message}\nout=\n${out}\nstderr=\n${err}`));
			}
		});
		(async () => {
			for (const cmd of commands) {
				const ok = child.stdin.write(`${JSON.stringify(cmd)}\n`);
				if (!ok) {
					await new Promise<void>((r) => child.stdin.once("drain", () => r()));
				}
			}
			child.stdin.end();
		})().catch(reject);
	});
}

describe("/worktree from inside a worktree", () => {
	it("anchors the new worktree at the main repo, not the current worktree", async () => {
		// Start the runner with cwd INSIDE the inner worktree. Without
		// `findCanonicalGitRoot`'s parent-walk, ensureSessionWorktree
		// would resolve `<inner>/.cast/worktrees/<name>` and produce a
		// linked worktree of a worktree — a layout bug the test is
		// specifically guarding against.
		const events = await runInteractive(
			[{ type: "command", name: "worktree", args: " nested" }, { type: "state" }, { type: "exit" }],
			innerRepo,
		);

		const stateEvents = events.filter((e) => e.type === "state");
		expect(stateEvents.length).toBeGreaterThan(1);
		const lastState = stateEvents[stateEvents.length - 1];
		const stateCwd = String(lastState?.cwd ?? "");
		// The new worktree must live at `<main>/.cast/worktrees/nested`,
		// NOT at `<inner>/.cast/worktrees/nested`. The `innerRepo` path
		// would have a path segment `worktrees/inner/...` somewhere;
		// assert the nested one lives under `outer/.cast/worktrees/nested`.
		expect(stateCwd).not.toContain("/worktrees/inner/");
		expect(stateCwd).toMatch(/[\\/]\.cast[\\/]worktrees[\\/]nested$/);

		// And git worktree list confirms the new worktree is registered
		// as a peer of the main repo, not as a child of `inner`.
		const list = execFileSync("git", ["-C", outerRepo, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
		});
		const paths = list
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim());
		expect(paths).toContain(stateCwd);
	}, 60_000);
});
