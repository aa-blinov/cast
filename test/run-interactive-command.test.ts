/**
 * JSONL `--interactive` protocol: `command` action — pipes a slash command
 * through `handleInput` so a headless consumer (test, agent, evaluator) can
 * exercise the same code path the TUI uses, without needing a real TTY.
 *
 * `cast run --interactive` is the only way to talk to the running session
 * over JSONL; extending it with a `command` action lets us verify
 * `/worktree`, `/clear`, `/persona` and friends end-to-end against the real
 * command dispatcher.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpRoot: string | undefined;
let repo: string | undefined;
let mockServer: Server | undefined;
let mockPort = 0;

// Tests spawn `node ./dist/index.js` — both the script and the `--cwd` repo
// must resolve from a stable anchor. The package ships a bundled
// `dist/index.js` at the repo root; we always invoke it via an absolute path
// so the child process doesn't have to care about its own cwd. `import.meta.url`
// under vitest points at the test file itself, so we walk up two levels to
// reach the package root (test/ → repo/).
const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), "cast-jsonl-"));
	repo = join(tmpRoot, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "--initial-branch=main", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
	writeFileSync(join(repo, "README.md"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

	// Mock OpenAI-compatible `/v1/models` endpoint so runStartup's
	// `probeProvider` call returns "ok" without leaving the test machine.
	// The endpoint must return at least one model id for the liveness
	// probe to consider the connection alive.
	mockServer = createServer((req, res) => {
		if (req.url?.startsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "noop", owned_by: "test", context_length: 4096 }],
				}),
			);
		} else if (req.url?.startsWith("/v1/chat/completions")) {
			// `runOnboardingCheck` validates the saved model by sending a
			// real chat completion request. Returning a minimal valid
			// response is enough — the runner never actually invokes the
			// model because the slash command short-circuits before any
			// prompt runs.
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
	if (addr && typeof addr === "object") {
		mockPort = addr.port;
		// Sanity log: if the parent process can't reach the mock, the test
		// will be dead in the water and we want the trace to be obvious.
		// eslint-disable-next-line no-console
		console.log(`[mock] listening on 127.0.0.1:${mockPort}`);
	} else {
		throw new Error(`mock server failed to bind: address() returned ${JSON.stringify(addr)}`);
	}
});

afterEach(async () => {
	if (mockServer) {
		await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
	}
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run `cast run --interactive` with the given JSONL commands piped on stdin,
 *  return the parsed JSONL events from stdout as an array.
 *
 *  Uses `spawn` (not `execFileSync`) because the host's loopback refuses
 *  connections from `execFileSync`'s child process — verified with a
 *  minimal reproduction that ran the same `node -e 'fetch(...).then(...)'`
 *  through `spawn` (works) and `execFileSync` (ETIMEDOUT). Same Node
 *  binary, same `127.0.0.1` address, same parent process. Likely
 *  something in this kind/k8s container's network namespace refuses
 *  child-initiated loopback when stdin is a file, but accepts it when
 *  stdin is a pipe. We don't fix the environment; we work around it.
 */
async function runInteractive(
	commands: Array<Record<string, unknown>>,
	cwdOverride?: string,
): Promise<Array<Record<string, unknown>>> {
	// The child reads `~/.cast/settings.json` and `~/.cast/sessions/...` —
	// point HOME at the per-test tempdir so the runner doesn't touch the
	// real home directory and so we can pre-seed it with a model + persona
	// + a mock OpenAI-compatible provider. Without those, noPickers aborts
	// the process before any input is processed.
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
			// Pre-seed a no-network provider so runStartup doesn't try to
			// prompt for one. The test never actually invokes the model
			// (slash commands only), so the URL/key are placeholders.
			providerUrl: `http://127.0.0.1:${mockPort}/v1`,
			apiKey: "test-key",
			providers: [{ name: "test", url: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key" }],
		}),
	);
	return new Promise((resolve, reject) => {
		const child = spawn("node", [DIST_ENTRY, "run", "--interactive", "--format", "json"], {
			cwd: cwdOverride ?? repo,
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
				// No JSONL events at all — surface the child's stderr so a
				// future failure points at the actual cause (noPickers
				// exit, probe failure, etc.) instead of an empty array.
				reject(new Error(`no JSONL events received from child\nstderr=\n${err}\nstdout=\n${out}`));
				return;
			}
			try {
				const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
				resolve(events);
			} catch (e) {
				reject(new Error(`failed to parse JSONL: ${(e as Error).message}\nout=\n${out}\nstderr=\n${err}`));
			}
		});
		// Push commands one at a time and only close stdin once each write
		// drains. The cast runner reads via readline and processes one action
		// per line, so flushing in order matters — closing stdin before the
		// child has processed earlier commands would short-circuit /exit
		// before it could act.
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

describe("JSONL protocol — command action", () => {
	it("dispatches /worktree and updates cwd visible via state", async () => {
		const events = await runInteractive([
			{ type: "command", name: "worktree", args: " feature-1" },
			{ type: "state" },
			{ type: "exit" },
		]);

		// /worktree emits a `notice` with the success message, then a `state`
		// event we asked for. The cwd in state.cwd must be the worktree path.
		const notices = events.filter((e) => e.type === "notice").map((e) => String(e.text ?? ""));
		expect(
			notices.some((t) => t.startsWith("[Creating worktree")),
			`expected a "Creating worktree" notice, got: ${notices.join(" | ")}`,
		).toBe(true);
		expect(
			notices.some((t) => t.startsWith("[Worktree:") && t.includes("cast-feature-1")),
			`expected a success notice, got: ${notices.join(" | ")}`,
		).toBe(true);

		// Multiple `state` events are emitted: one at startup, one after
		// each `command`/etc. resolves. The last one reflects the cwd
		// change from /worktree, not the initial snapshot.
		const stateEvents = events.filter((e) => e.type === "state");
		expect(stateEvents.length).toBeGreaterThan(1);
		const lastState = stateEvents[stateEvents.length - 1];
		const stateCwd = String(lastState?.cwd ?? "");
		expect(stateCwd).toMatch(/\.cast[\\/]worktrees[\\/]feature-1$/);
		expect(stateCwd).not.toBe(repo);
	}, 60_000);

	it("reuses an existing worktree on the same name (no duplicate)", async () => {
		const first = await runInteractive([{ type: "command", name: "worktree", args: " reuse-me" }]);
		const second = await runInteractive([{ type: "command", name: "worktree", args: " reuse-me" }]);

		const firstNotice = first
			.filter((e) => e.type === "notice")
			.map((e) => String(e.text ?? ""))
			.find((t) => t.startsWith("[Worktree:"));
		const secondNotice = second
			.filter((e) => e.type === "notice")
			.map((e) => String(e.text ?? ""))
			.find((t) => t.startsWith("[Worktree:"));
		expect(firstNotice).toBeDefined();
		expect(secondNotice).toBeDefined();
		// Same worktree, same path — and `git worktree list` shouldn't show a
		// duplicate. (Path is reported as the worktree argument's resolved
		// absolute form, so the equality check is path-level.)
		const pathMatch = /Worktree: (.+?) \(/;
		const firstPath = firstNotice!.match(pathMatch)?.[1] ?? "";
		const secondPath = secondNotice!.match(pathMatch)?.[1] ?? "";
		expect(secondPath).toBe(firstPath);

		const list = execFileSync("git", ["-C", repo!, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
		});
		// Each entry is a block; the worktree path appears on the `worktree <path>` line.
		const worktreePaths = list
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim());
		const matches = worktreePaths.filter((p) => p.endsWith("reuse-me"));
		expect(matches.length).toBe(1);
	}, 90_000);

	it("emits an error notice when /worktree is invoked outside a git repo", async () => {
		// Build a JSONL run from /tmp (not a git repo). The runner's cwd
		// resolution walks up looking for `.git`; starting in /tmp means
		// nothing is found, which is exactly the `not a git repository` path
		// the upstream error message targets.
		const nonRepoTmp = mkdtempSync(join(tmpdir(), "cast-jsonl-norepo-"));
		try {
			const events = await runInteractive(
				[{ type: "command", name: "worktree", args: " foo" }, { type: "exit" }],
				nonRepoTmp,
			);
			const notices = events.filter((e) => e.type === "notice").map((e) => String(e.text ?? ""));
			const errors = events.filter((e) => e.type === "error").map((e) => String(e.message ?? ""));
			const failure =
				notices.find((t) => t.startsWith("[Worktree failed")) ?? errors.find((t) => t.includes("git repository"));
			expect(
				failure,
				`expected a worktree-failed notice/error, got notices=[${notices.join(" | ")}] errors=[${errors.join(" | ")}]`,
			).toBeDefined();
		} finally {
			rmSync(nonRepoTmp, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects unknown action types with a parse error", async () => {
		const events = await runInteractive([{ type: "no-such-action" }, { type: "exit" }], repo);
		const errors = events.filter((e) => e.type === "error").map((e) => String(e.message ?? ""));
		expect(errors.length).toBeGreaterThan(0);
	}, 30_000);
});
