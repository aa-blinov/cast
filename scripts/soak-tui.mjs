#!/usr/bin/env node
/**
 * Soak test for the terminal UI: fills the transcript, scrolls, resizes and opens pickers against a fake streaming
 * provider, and reports what that cost the TUI and the daemon.
 *
 *   npm run soak:tui [-- --quick] [-- --turns 40] [-- --keep] [-- --json out.json]
 *
 * What it measures, per phase, for the TUI process and the daemon:
 *  - live heap after a forced GC, read over the inspector (so a leak shows as heap that does not come back, not as RSS
 *    noise), plus RSS and its high-water mark from /proc;
 *  - event-loop delay (p99 and max, the "UI froze" number) between phases, read from a monitor installed in the process;
 *  - how long a typed character takes to show on the screen while a turn streams.
 * It fails (exit 1) when heap does not return to near its baseline after /clear, grows across identical cycles, or
 * the event loop stalls longer than the budget.
 *
 * Needs tmux and a built bundle (npm run build). Everything runs in a throwaway HOME and its own tmux server; no
 * provider, key or real session is used. The model is a local server that streams text, reasoning and tool calls.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST = join(ROOT, "dist", "index.js");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const QUICK = flag("quick");
const TURNS = Number(option("turns", QUICK ? 6 : 24));
const LINES_PER_TURN = Number(option("lines", 400));
const LAG_BUDGET_MS = Number(option("lag-budget", 250));
const HEAP_BUDGET_MB = Number(option("heap-budget", 60));
const SLOPE_BUDGET_MB = Number(option("slope-budget", 12));
const KEEP = flag("keep");
// The daemon cuts a client that falls this far behind; a low limit makes it cut the TUI mid-turn on large events, which
// is how the reconnect path (and a stale state fetch landing after the turn has ended) gets exercised.
const FORCE_DROPS = flag("force-stream-drops");
const SNAPSHOT_DIR = option("snapshots", "");
const EDIT_KB = Number(option("edit-kb", FORCE_DROPS ? 1024 : 256));
const CYCLES = Number(option("cycles", QUICK ? 3 : 5));
const JSON_OUT = option("json", "");
const COLS = 100;
const ROWS = 40;

if (!existsSync(DIST)) {
	console.error("dist/index.js is missing: run `npm run build` first.");
	process.exit(2);
}
try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	console.error("tmux is required.");
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// ── The fake provider ─────────────────────────────────────────────────────────────────────────────────────────────

function lineFor(k) {
	if (k % 100 === 0) return `## Section ${k / 100}`;
	if (k % 50 === 1) return "```js";
	if (k % 50 >= 2 && k % 50 <= 8) return `const value${k} = compute(${k}, "x".repeat(${k % 9})); // line of code ${k}`;
	if (k % 50 === 9) return "```";
	if (k % 37 === 0) return `| row ${k} | **bold** | \`code\` | ${"cell ".repeat(k % 5)} |`;
	if (k % 11 === 0) return `- item ${k}: a list entry with *emphasis* and a [link](https://example.com/${k})`;
	return `Line ${k}: ordinary prose with **bold**, \`inline code\` and enough words to wrap at the width of a normal terminal window, number ${k}.`;
}

const stats = { requests: 0, completed: 0 };

function startProvider() {
	return new Promise((resolveStart) => {
		const server = createServer((req, res) => {
			if (req.url?.startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "soak-model", context_length: 8_000_000 }] }));
				return;
			}
			if (!req.url?.startsWith("/v1/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				let body = {};
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
				} catch {
					// not JSON: answer plainly
				}
				stats.requests += 1;
				void respond(body, res);
			});
		});
		server.listen(0, "127.0.0.1", () => resolveStart({ server, port: server.address().port }));
	});
}

function lastUserText(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
		if (m.role === "tool") return "__tool_result__";
	}
	return "";
}

async function respond(body, res) {
	const text = lastUserText(body);
	const scenario = /SOAK_(TEXT|TOOL|THINK|EDIT)(?::(\d+))?/.exec(text);
	const kind = text === "__tool_result__" ? "after-tool" : (scenario?.[1] ?? "short");
	const size = Number(scenario?.[2] ?? 20);
	const chunk = (delta, finish = null) =>
		`data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", created: 0, model: "soak-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const done = (finish) => {
		res.write(chunk({}, finish));
		res.write(
			`data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", created: 0, model: "soak-model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } })}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				id: "soak",
				object: "chat.completion",
				choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
		stats.completed += 1;
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	if (kind === "TOOL") {
		const kb = size;
		res.write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${stats.requests}`,
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: `head -c ${kb * 1024} /dev/zero | tr '\\0' 'x' | fold -w 100` }),
						},
					},
				],
			}),
		);
		done("tool_calls");
		return;
	}
	if (kind === "EDIT") {
		// Rewrites one file git ignores, so each turn's checkpoint has to keep a copy of what it replaced for /undo.
		res.write(
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call_${stats.requests}`,
						type: "function",
						function: {
							name: "write",
							arguments: JSON.stringify({ path: "ignored.out", content: `${stats.requests} ${"y".repeat(size * 1024)}\n` }),
						},
					},
				],
			}),
		);
		done("tool_calls");
		return;
	}
	if (kind === "THINK") {
		for (let k = 0; k < Math.floor(size / 4); k++) {
			res.write(chunk({ reasoning_content: `Thinking step ${k}: weighing the options for line ${k}.\n` }));
			if (k % 20 === 0) await sleep(1);
		}
	}
	const lines = kind === "TEXT" || kind === "THINK" ? size : 2;
	if (kind === "after-tool") res.write(chunk({ content: "The command finished; the output is above." }));
	else
		for (let k = 0; k < lines; k++) {
			res.write(chunk({ content: `${lineFor(k)}\n` }));
			if (k % 8 === 0) await sleep(1);
		}
	done("stop");
	stats.completed += 1;
}

// ── tmux, the inspector and /proc ─────────────────────────────────────────────────────────────────────────────────

const SOCK = `cast-soak-${process.pid}`;
const tmux = (...args) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf-8" });
const screen = () => {
	try {
		return tmux("capture-pane", "-p", "-t", "soak");
	} catch {
		return "";
	}
};
const typeText = (text) => tmux("send-keys", "-t", "soak", "-l", "--", text);
const press = (...keys) => tmux("send-keys", "-t", "soak", ...keys);

async function waitScreen(predicate, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(screen())) return;
		await sleep(40);
	}
	throw new Error(`timed out waiting for ${what}.\n--- screen ---\n${screen()}`);
}

/** The prompt is idle and stays idle: it can flash back between a tool finishing and the next request going out. */
async function waitIdle(timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	let stable = 0;
	while (Date.now() < deadline) {
		stable = screen().includes(IDLE) ? stable + 1 : 0;
		if (stable >= 6) return;
		await sleep(80);
	}
	throw new Error(`timed out waiting for ${what}.\n--- screen ---\n${screen()}`);
}

async function connectInspector(port) {
	let list;
	for (let i = 0; i < 100; i++) {
		try {
			list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			if (list?.length) break;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	if (!list?.length) throw new Error(`no inspector on port ${port}`);
	const ws = new WebSocket(list[0].webSocketDebuggerUrl);
	await new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = fail;
	});
	let id = 0;
	const pending = new Map();
	const listeners = new Map();
	ws.onmessage = (m) => {
		const d = JSON.parse(m.data);
		const done = d.id && pending.get(d.id);
		if (done) {
			pending.delete(d.id);
			done(d);
		} else if (d.method) {
			listeners.get(d.method)?.(d.params);
		}
	};
	const send = (method, params = {}) =>
		new Promise((ok, fail) => {
			const n = ++id;
			pending.set(n, (d) => (d.error ? fail(new Error(`${method}: ${d.error.message}`)) : ok(d.result)));
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	const evaluate = async (expression) =>
		(await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false })).result.value;
	const pid = await evaluate(
		"(() => { const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks'); const h = monitorEventLoopDelay({ resolution: 5 }); h.enable(); globalThis.__eld = h; return process.pid; })()",
	);
	return {
		pid,
		async measure() {
			await send("HeapProfiler.collectGarbage");
			const heap = await send("Runtime.getHeapUsage");
			const lag = await evaluate(
				"(() => { const h = globalThis.__eld; const r = { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 }; h.reset(); return r; })()",
			);
			const status = readFileSync(`/proc/${pid}/status`, "utf-8");
			const kb = (key) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
			return { heapMb: mb(heap.usedSize), rssMb: mb(kb("VmRSS") * 1024), rssPeakMb: mb(kb("VmHWM") * 1024), lag };
		},
		/** Event-loop delay since the last read, without collecting garbage first (that would be the stall). */
		async lagOnly() {
			return evaluate(
				"(() => { const h = globalThis.__eld; const r = { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 }; h.reset(); return r; })()",
			);
		},
		/** Writes a V8 heap snapshot (after a GC) to `path`, to diff two of them and see what accumulates. */
		async heapSnapshot(path) {
			const chunks = [];
			listeners.set("HeapProfiler.addHeapSnapshotChunk", (params) => chunks.push(params.chunk));
			await send("HeapProfiler.collectGarbage");
			await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
			listeners.delete("HeapProfiler.addHeapSnapshotChunk");
			writeFileSync(path, chunks.join(""));
		},
		/** Start/stop the CPU profiler; `stopProfile` returns the profile as an object. */
		startProfile: async () => {
			await send("Profiler.enable");
			await send("Profiler.setSamplingInterval", { interval: 1000 });
			await send("Profiler.start");
		},
		stopProfile: async () => (await send("Profiler.stop")).profile,
		close: () => ws.close(),
	};
}

// ── Driving the TUI ───────────────────────────────────────────────────────────────────────────────────────────────

const IDLE = "ask cast to do anything";

/** How many messages the daemon holds for the project's session, asked of the daemon itself (not the TUI's copy). */
async function daemonMessageCount() {
	const state = JSON.parse(readFileSync(join(home, ".cast", "server.json"), "utf-8"));
	const headers = { authorization: `Bearer ${state.token}` };
	const base = `http://127.0.0.1:${state.port}`;
	const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
	const mine = list.filter((x) => x.cwd === project).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)))[0];
	if (!mine) return -1;
	const full = await (await fetch(`${base}/api/sessions/${mine.id}`, { headers })).json();
	return Array.isArray(full.messages) ? full.messages.length : -1;
}

async function runTurn(prompt) {
	const before = stats.completed;
	press("C-u");
	typeText(prompt);
	press("Enter");
	const deadline = Date.now() + 120_000;
	while (stats.completed === before && Date.now() < deadline) await sleep(50);
	if (stats.completed === before) {
		throw new Error(`the fake provider never finished "${prompt}".\n--- screen ---\n${screen()}`);
	}
	await waitIdle(60_000, "the prompt to come back after a turn");
}

/** How long a typed character takes to appear, sampled while whatever is running runs. */
async function echoLatencies(samples) {
	const out = [];
	for (let i = 0; i < samples; i++) {
		const mark = `q${i}z${Math.floor(Math.random() * 1e6)}`;
		const t0 = performance.now();
		typeText(mark);
		const deadline = t0 + 5000;
		while (performance.now() < deadline && !screen().includes(mark)) await sleep(10);
		out.push(performance.now() - t0);
		press("C-u");
		await sleep(30);
	}
	return out;
}

const pct = (values, p) => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const WHEEL_UP = "\x1b[<64;50;12M";
const WHEEL_DOWN = "\x1b[<65;50;12M";

function wheelBurst(sequence, count) {
	typeText(sequence.repeat(count));
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "cast-soak-"));
const project = join(home, "proj");
mkdirSync(project, { recursive: true });
const children = [];
const report = { phases: [], verdicts: [] };
let tuiInspector;
let daemonInspector;

let finishing = false;
/** Stop what was started and remove the throwaway HOME, then exit: the daemon is given time to stop writing first. */
async function finish(code) {
	if (finishing) return;
	finishing = true;
	if (KEEP && code !== 0) {
		console.error(`--keep: left running for inspection. tmux -L ${SOCK} attach -t soak ; HOME ${home}`);
		process.exit(code);
	}
	try {
		tmux("kill-server");
	} catch {
		// not running
	}
	await Promise.all(
		children.map(
			(child) =>
				new Promise((done) => {
					if (child.exitCode !== null || child.signalCode !== null) return done();
					child.once("exit", done);
					child.kill("SIGTERM");
					setTimeout(() => {
						child.kill("SIGKILL");
						done();
					}, 3000).unref();
				}),
		),
	);
	if (!KEEP) {
		try {
			rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			// a leftover temp directory is not worth failing the run
		}
	}
	process.exit(code);
}
process.on("SIGINT", () => void finish(130));

async function snapshot(name, extra = {}) {
	const tui = await tuiInspector.measure();
	const daemon = await daemonInspector.measure();
	const row = { phase: name, tui, daemon, ...extra };
	report.phases.push(row);
	const lag = (l) => `p99 ${l.p99.toFixed(0)} / max ${l.max.toFixed(0)} ms`;
	console.log(
		`${name.padEnd(30)} tui heap ${String(tui.heapMb).padStart(6)} MB rss ${String(tui.rssMb).padStart(6)} MB  lag ${lag(tui.lag).padEnd(24)} | daemon heap ${String(daemon.heapMb).padStart(6)} MB rss ${String(daemon.rssMb).padStart(6)} MB  lag ${lag(daemon.lag)}`,
	);
	return row;
}

async function main() {
	const { server, port } = await startProvider();
	mkdirSync(join(home, ".cast"), { recursive: true });
	writeFileSync(
		join(home, ".cast", "settings.json"),
		JSON.stringify({
			model: "soak-model",
			persona: "senior",
			reasoningLevel: "off",
			providerUrl: `http://127.0.0.1:${port}/v1`,
			apiKey: "soak",
			providers: [{ name: "soak", url: `http://127.0.0.1:${port}/v1`, apiKey: "soak" }],
			permissionMode: "bypass",
			memoryEnabled: false,
			showReasoning: true,
			webTools: false,
		}),
	);
	execFileSync("git", ["init", "-q"], { cwd: project });
	writeFileSync(join(project, ".gitignore"), "*.out\n");

	const env = {
		...process.env,
		HOME: home,
		CAST_CWD: project,
		CAST_NO_MOUSE: "",
		...(FORCE_DROPS ? { CAST_SSE_BACKLOG_KB: "1024" } : {}),
	};
	const daemonLog = openSync(join(home, "daemon.log"), "a");
	const DAEMON_PORT = 9400 + (process.pid % 300);
	const TUI_PORT = DAEMON_PORT + 300;

	// Started here rather than by the TUI so it can be inspected; the TUI finds it through the state file.
	const daemon = spawn(
		process.execPath,
		[`--inspect=127.0.0.1:${DAEMON_PORT}`, DIST, "server", "start", "--foreground", "--port", "0", "--host", "127.0.0.1"],
		{ cwd: ROOT, env, stdio: ["ignore", daemonLog, daemonLog] },
	);
	children.push(daemon);
	for (let i = 0; i < 200 && !existsSync(join(home, ".cast", "server.json")); i++) await sleep(100);
	if (!existsSync(join(home, ".cast", "server.json"))) throw new Error("the daemon did not start");

	tmux(
		"new-session",
		"-d",
		"-s",
		"soak",
		"-x",
		String(COLS),
		"-y",
		String(ROWS),
		"-c",
		project,
		`env HOME=${home} CAST_CWD=${project} node --disable-warning=ExperimentalWarning --inspect=127.0.0.1:${TUI_PORT} ${DIST}; sleep 999`,
	);
	await waitScreen((s) => s.includes(IDLE), 60_000, "the TUI to start");
	tuiInspector = await connectInspector(TUI_PORT);
	daemonInspector = await connectInspector(DAEMON_PORT);
	console.log(`soak: tui pid ${tuiInspector.pid}, daemon pid ${daemonInspector.pid}, ${TURNS} turns of ${LINES_PER_TURN} lines\n`);

	await runTurn("hello");
	const baseline = await snapshot("baseline");

	// 1. Fill the transcript with streamed turns; type while they stream.
	const echoDuring = [];
	for (let i = 0; i < TURNS; i++) {
		const before = stats.completed;
		press("C-u");
		typeText(`SOAK_TEXT:${LINES_PER_TURN}`);
		press("Enter");
		await sleep(60);
		if (i % 4 === 0) echoDuring.push(...(await echoLatencies(3)));
		const deadline = Date.now() + 120_000;
		while (stats.completed === before && Date.now() < deadline) await sleep(50);
		await waitIdle(60_000, "the prompt to come back");
		if ((i + 1) % Math.max(1, Math.floor(TURNS / 4)) === 0) await snapshot(`fill: ${i + 1} turns`);
	}
	const filled = await snapshot("filled");
	report.echoDuringStreamMs = { p50: pct(echoDuring, 50), p95: pct(echoDuring, 95), max: Math.max(0, ...echoDuring) };

	// 2. Reasoning blocks and large tool results.
	for (let i = 0; i < Math.max(2, Math.floor(TURNS / 6)); i++) await runTurn(`SOAK_THINK:${LINES_PER_TURN}`);
	for (let i = 0; i < Math.max(2, Math.floor(TURNS / 6)); i++) await runTurn("SOAK_TOOL:2048");
	await snapshot("thinking + tool output");

	// 3. Scroll: wheel and keys, up and down, over the whole transcript.
	await tuiInspector.lagOnly();
	const scrollStart = performance.now();
	for (let round = 0; round < (QUICK ? 6 : 30); round++) {
		wheelBurst(WHEEL_UP, 60);
		await sleep(20);
		wheelBurst(WHEEL_DOWN, 40);
		press("PageUp", "PageUp", "PageUp", "PageUp");
		press("PageDown", "PageDown");
		await sleep(20);
	}
	press("Home");
	await sleep(300);
	press("End");
	await sleep(500);
	const scrollMs = performance.now() - scrollStart;
	await snapshot("scroll storm", { scrollMs: Math.round(scrollMs) });

	// 4. Streaming while the person scrolls.
	press("C-u");
	typeText(`SOAK_TEXT:${LINES_PER_TURN * 2}`);
	press("Enter");
	await sleep(100);
	for (let i = 0; i < 20; i++) {
		wheelBurst(WHEEL_UP, 15);
		await sleep(25);
		wheelBurst(WHEEL_DOWN, 10);
		await sleep(25);
	}
	await waitIdle(60_000, "the stream to finish");
	await snapshot("scroll while streaming");

	// 5. Resize: every width below the measure re-lays-out the whole transcript.
	await tuiInspector.lagOnly();
	const resizes = QUICK ? 12 : 40;
	const sizes = [
		[60, 30],
		[84, 36],
		[120, 40],
		[46, 24],
		[100, 40],
		[72, 28],
	];
	const resizeStart = performance.now();
	for (let i = 0; i < resizes; i++) {
		const [w, h] = sizes[i % sizes.length];
		tmux("resize-window", "-t", "soak", "-x", String(w), "-y", String(h));
		await sleep(40);
	}
	tmux("resize-window", "-t", "soak", "-x", String(COLS), "-y", String(ROWS));
	await sleep(1500);
	await snapshot("resize storm", { resizeMs: Math.round(performance.now() - resizeStart) });

	// 6. Open and close pickers.
	for (let i = 0; i < (QUICK ? 15 : 60); i++) {
		for (const command of ["/theme", "/settings", "/model"]) {
			press("C-u");
			typeText(command);
			press("Enter");
			await sleep(80);
			press("Escape");
			await sleep(150);
			press("Escape");
			await sleep(150);
		}
	}
	press("C-u");
	await sleep(200);
	await snapshot("picker churn");

	// 6b. Undo history: each turn that rewrites a large file git ignores keeps a copy of the old one.
	const beforeEdits = await snapshot("before file edits");
	const EDITS = QUICK ? 6 : 16;
	const PROFILE_EDITS = option("profile-edits", "");
	if (PROFILE_EDITS) {
		await tuiInspector.startProfile();
		await daemonInspector.startProfile();
	}
	for (let i = 0; i < EDITS; i++) await runTurn(`SOAK_EDIT:${EDIT_KB}`);
	if (PROFILE_EDITS) {
		writeFileSync(PROFILE_EDITS, JSON.stringify(await tuiInspector.stopProfile()));
		writeFileSync(`${PROFILE_EDITS}.daemon`, JSON.stringify(await daemonInspector.stopProfile()));
	}
	const afterEdits = await snapshot(`${EDITS} edits of a ${EDIT_KB} KB file`);
	report.perEditMb = {
		tui: (afterEdits.tui.heapMb - beforeEdits.tui.heapMb) / EDITS,
		daemon: (afterEdits.daemon.heapMb - beforeEdits.daemon.heapMb) / EDITS,
	};

	// 7. Does memory come back? Identical cycles of fill + /clear: the heap after each /clear must not climb.
	const afterClear = [];
	const daemonAfterClear = [];
	for (let cycle = 0; cycle < CYCLES; cycle++) {
		for (let i = 0; i < 3; i++) await runTurn(`SOAK_TEXT:${LINES_PER_TURN}`);
		await runTurn("SOAK_TOOL:512");
		press("C-u");
		typeText("/clear");
		press("Enter");
		await waitScreen((s) => !s.includes("SOAK_"), 20_000, "the transcript to clear");
		await sleep(500);
		// The TUI emptied its own view, but the conversation the model is sent is the daemon's: /clear used to leave it whole.
		daemonAfterClear.push(await daemonMessageCount());
		const row = await snapshot(`clear cycle ${cycle + 1}`);
		afterClear.push(row);
		if (SNAPSHOT_DIR && (cycle === 2 || cycle === CYCLES - 1)) {
			mkdirSync(SNAPSHOT_DIR, { recursive: true });
			await daemonInspector.heapSnapshot(join(SNAPSHOT_DIR, `daemon-cycle-${cycle + 1}.heapsnapshot`));
			await tuiInspector.heapSnapshot(join(SNAPSHOT_DIR, `tui-cycle-${cycle + 1}.heapsnapshot`));
		}
	}

	// ── Verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────
	const verdict = (ok, text) => report.verdicts.push({ ok, text });
	const last = afterClear.at(-1);
	for (const [name, base, now] of [
		["TUI", baseline.tui, last.tui],
		["daemon", baseline.daemon, last.daemon],
	]) {
		const grew = now.heapMb - base.heapMb;
		verdict(grew <= HEAP_BUDGET_MB, `${name} heap after /clear is ${grew >= 0 ? "+" : ""}${grew.toFixed(1)} MB against the baseline (budget ${HEAP_BUDGET_MB})`);
	}
	for (const [name, pick] of [
		["TUI", (r) => r.tui.heapMb],
		["daemon", (r) => r.daemon.heapMb],
	]) {
		const slope = (pick(afterClear.at(-1)) - pick(afterClear[0])) / Math.max(1, afterClear.length - 1);
		verdict(slope <= SLOPE_BUDGET_MB, `${name} heap grows ${slope.toFixed(1)} MB per identical cycle after /clear (budget ${SLOPE_BUDGET_MB})`);
	}
	// Retained copies of a rewritten ignored file are bounded by the checkpoint cap (64 MB per session), so what is
	// checked is that they are let go with the session, which the heap-after-/clear verdicts above do; the rate is
	// printed for reference.
	console.log(
		`\nundo copies: the TUI holds ${report.perEditMb.tui.toFixed(1)} MB and the daemon ${report.perEditMb.daemon.toFixed(1)} MB per edit of a ${EDIT_KB} KB ignored file, until the 64 MB cap`,
	);
	for (const [name, pick] of [
		["TUI", (r) => r.tui.rssMb],
		["daemon", (r) => r.daemon.rssMb],
	]) {
		const rssSlope = (pick(afterClear.at(-1)) - pick(afterClear[Math.min(1, afterClear.length - 1)])) / Math.max(1, afterClear.length - 2);
		verdict(rssSlope <= SLOPE_BUDGET_MB, `${name} RSS grows ${rssSlope.toFixed(2)} MB per identical cycle after /clear (budget ${SLOPE_BUDGET_MB})`);
	}
	verdict(
		daemonAfterClear.every((n) => n === 0),
		`the daemon holds no messages right after /clear (saw ${daemonAfterClear.join(", ")})`,
	);
	const worstLag = Math.max(...report.phases.map((p) => p.tui.lag.max));
	verdict(worstLag <= LAG_BUDGET_MS, `worst TUI event-loop stall ${worstLag.toFixed(0)} ms (budget ${LAG_BUDGET_MS})`);
	verdict(
		report.echoDuringStreamMs.p95 <= 600,
		`typing while a turn streams: p50 ${report.echoDuringStreamMs.p50.toFixed(0)} ms, p95 ${report.echoDuringStreamMs.p95.toFixed(0)} ms (includes tmux; budget p95 600)`,
	);
	report.provider = { requests: stats.requests, completed: stats.completed };
	server.close();

	console.log("");
	for (const v of report.verdicts) console.log(`${v.ok ? "ok  " : "FAIL"} ${v.text}`);
	if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
	tuiInspector.close();
	daemonInspector.close();
	await finish(report.verdicts.every((v) => v.ok) ? 0 : 1);
}

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await finish(1);
});
