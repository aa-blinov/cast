#!/usr/bin/env node
/**
 * End-to-end check that the TUI's live region stays inside the viewport.
 *
 * Runs the built TUI inside a real pseudo-terminal (node-pty) against a fake
 * OpenAI-compatible provider on localhost — no tokens are spent and nothing
 * leaves the machine — and streams a long single-line CJK answer, the case
 * where a cell/character mix-up in the clamp used to matter most.
 *
 * What it measures: Ink 7 does not stack duplicate frames when a frame is
 * taller than the terminal (older Ink did). It writes `clearTerminal` plus a
 * replay of all static output instead — see renderInteractiveFrame in
 * node_modules/ink/build/ink.js — so the symptom is the whole screen and the
 * scrollback being wiped and rebuilt on *every* frame while the answer
 * streams. Counting `\x1b[2J` / `\x1b[3J` in the terminal's byte stream is
 * therefore a direct, unambiguous signal.
 *
 * Measured on this scenario (30-row terminal, ~4,000 wide characters):
 *   before the cell-accurate clamp: 49 full clears, 202KB of output
 *   after:                           0 full clears,  24KB
 *
 * Usage: npm run build && node scripts/e2e-tui-frames.mjs
 * Exits non-zero if the live region overran (any full clear during streaming).
 */

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const ROWS = 30;
const COLS = 100;
const PORT = 18999;
const CJK_LINE = "日本語のテキストです".repeat(400);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function startFakeProvider() {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			if (req.url.includes("/models")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
				return;
			}
			if (!req.url.includes("/chat/completions")) {
				res.writeHead(404);
				res.end("{}");
				return;
			}
			let streaming = false;
			let wantsLong = false;
			try {
				const parsed = JSON.parse(body);
				streaming = parsed.stream === true;
				wantsLong = JSON.stringify(parsed.messages ?? "").includes("LONGCJK");
			} catch {}
			if (!streaming) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						id: "1",
						object: "chat.completion",
						model: "test-model",
						choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
					}),
				);
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
			const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			const chunks = wantsLong ? 40 : 1;
			for (let i = 0; i < chunks; i++) {
				const content = wantsLong ? CJK_LINE.slice(i * 100, (i + 1) * 100) : "ok";
				send({
					id: "1",
					object: "chat.completion.chunk",
					model: "test-model",
					choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
				});
				if (wantsLong) await wait(60);
			}
			send({
				id: "1",
				object: "chat.completion.chunk",
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
			});
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const provider = await startFakeProvider();
const home = mkdtempSync(join(tmpdir(), "cast-tui-frames-"));
const project = join(home, "project");
mkdirSync(join(home, ".cast"), { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(
	join(home, ".cast", "settings.json"),
	`${JSON.stringify(
		{
			persona: "senior",
			model: "test-model",
			providerUrl: `http://127.0.0.1:${PORT}/v1`,
			apiKey: "dummy-not-a-real-key",
			providers: [{ name: "fake", url: `http://127.0.0.1:${PORT}/v1`, apiKey: "dummy-not-a-real-key" }],
			projectTrust: { [project]: "trusted" },
			memoryWriteEnabled: false,
			showReasoning: true,
		},
		null,
		2,
	)}\n`,
);

const term = pty.spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "index.js")], {
	name: "xterm-256color",
	cols: COLS,
	rows: ROWS,
	cwd: project,
	env: { ...process.env, HOME: home, TERM: "xterm-256color" },
});

let seen = "";
term.onData((data) => {
	seen += data;
});

await wait(9000);
// First run in a fresh HOME asks for a reasoning level; Enter accepts.
if (stripAnsi(seen).includes("Reasoning levels")) {
	term.write("\r");
	await wait(2500);
}

seen = "";
term.write("LONGCJK stream the long line\r");
await wait(9000);

const clears = [...seen.matchAll(/\x1b\[2J/g)].length;
const scrollbackWipes = [...seen.matchAll(/\x1b\[3J/g)].length;
const bytes = seen.length;

// Phase two: the live region is not only the streaming answer. A long draft
// in the composer, and the receipt rows for messages queued mid-turn, used to
// wrap to as many rows as they liked — 210 full clears (and 1.8MB) for two
// long /queue messages during a stream, the scrollback gone with them.
const typeSlowly = async (text) => {
	for (let i = 0; i < text.length; i += 8) {
		term.write(text.slice(i, i + 8));
		await wait(12);
	}
};
seen = "";
term.write("LONGCJK stream again\r");
await wait(1500);
for (const draft of ["queued text that is long ", "second queued message just as long "]) {
	await typeSlowly(`/queue ${draft.repeat(24)}`);
	await wait(300);
	term.write("\r");
	await wait(1200);
}
await wait(2500);
const composerClears = [...seen.matchAll(/\x1b\[2J/g)].length;

term.write("\x03");
await wait(200);
term.write("\x03");
await wait(800);
term.kill();
provider.close();
rmSync(home, { recursive: true, force: true });

console.log(`full screen clears while streaming: ${clears} (scrollback wipes: ${scrollbackWipes}), ${bytes} bytes`);
console.log(`full screen clears while typing a long draft and queueing mid-turn: ${composerClears}`);
if (composerClears > 0) {
	console.error("FAIL: a long composer draft or a queued-message row grew the live region past the viewport.");
	process.exit(1);
}
if (clears > 0) {
	console.error("FAIL: the live region grew taller than the viewport — Ink cleared and replayed the screen.");
	process.exit(1);
}
console.log("PASS: the live region stayed inside the viewport.");
