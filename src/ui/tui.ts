import { resolve } from "node:path";
import { runHooksForEvent } from "../core/hooks.ts";
import { closeMcpConnections } from "../core/mcp.ts";
import { drainProjectCheckpointWriters } from "../core/memory.ts";
import { listSessionSummaries, saveSession, sessionHasMessages } from "../core/session.ts";
import { type ParsedArgs, runStartup } from "../core/startup.ts";
import type { Pickers } from "../pickers/types.ts";
import { daemonBaseUrl, readLiveServerState } from "../server/daemon-state.ts";
import { runPiFrontEnd } from "../ui-pi/run.ts";
import { createStartupUi } from "../ui-pi/startup.ts";
import { type ClipboardPasteResult, saveClipboardImageToTempFile } from "./readClipboardImage.ts";
import { resumeCommand, resumeHint, writeLastResume } from "./resume-hint.ts";
import { loadTheme } from "./themes/index.ts";
import { logTuiError, reportFatal } from "./tui-errors.ts";

/**
 * TUI entry point: runStartup on the start-up screen, then the pi-tui front end.
 *
 * runStartup can take a few seconds (silent model re-check, MCP handshakes), so
 * its progress text goes on the start-up screen instead of a blank terminal.
 */
export async function runTui(args: ParsedArgs, daemonToken?: string): Promise<void> {
	// Node 22 has no global EventSource; the TUI pulls undici's experimental
	// build to receive the daemon's SSE stream. undici emits a one-time
	// "EventSource is experimental" (code UNDICI-ES) warning on first use —
	// it's noisy and meaningless for us, so suppress just that code. Other
	// warnings are replayed to the original listener so nothing else is lost.
	// A rejection nobody handled ends the process by default, mid-turn, with a
	// stack dumped into the alternate screen. Keep the session alive and leave a
	// trail in ~/.cast/tui-errors.log instead.
	// An exception nobody caught outside a turn (a turn has its own handler, which decides whether a dropped
	// stream is survivable): end with the reason on the normal screen, not a stack lost in the alternate one.
	process.on("uncaughtException", (error) => {
		if (process.listenerCount("uncaughtException") > 1) return;
		reportFatal("uncaught exception", error);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		logTuiError("unhandled rejection", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
	});
	const warningListeners = process.listeners("warning");
	process.removeAllListeners("warning");
	process.on("warning", (w) => {
		if ((w as Error & { code?: string })?.code === "UNDICI-ES") return;
		for (const l of warningListeners) l(w);
	});
	// Single-writer daemon: the `cast server` daemon owns runAgentLoop and streams
	// events to every surface. When a daemon is live, point the TUI at it as a
	// thin client (HTTP + SSE) instead of running the loop locally. daemonToken
	// is only set when a loopback daemon exists (see index.ts ensureDaemon);
	// read its port/host from the same state file the token came from.
	const daemonState = daemonToken ? readLiveServerState() : undefined;
	const daemonUrl = daemonState ? daemonBaseUrl(daemonState) : undefined;
	const startup = createStartupUi();
	const pickers: Pickers = startup.pickers;

	// Load the saved theme before any UI — the startup spinner reads gradient
	// endpoints from the active theme.
	loadTheme(args.settings.theme);

	startup.progress("Starting cast...");
	const result = await runStartup(args, pickers, startup.progress);
	startup.done();

	// Background bash tasks are spawned detached (their own process group, see
	// tools/bash-background.ts) specifically so a running command's own
	// Ctrl+C doesn't kill it — but that also means a terminal-delivered
	// SIGINT to *this* process's group never reaches them either. `exit`
	// fires synchronously on every normal termination path (explicit
	// onQuit, an uncaught SIGINT with no other handler, a thrown error) short
	// of `kill -9`, so it's the one place that reliably reaps orphans
	// regardless of how the TUI is closed.
	process.on("exit", () => result.backgroundTasks.killAll());

	if (result.hooks) {
		void runHooksForEvent(result.hooks, {
			event: "SessionStart",
			cwd: result.cwd,
			sessionId: result.session.id,
			payload: { source: result.resumed ? "resume" : "startup" },
		});
	}

	// Leaving the session behind is only useful if you can get back into it,
	// and the id is nowhere on screen — the exit clears it along with the rest
	// of the frame. Print the exact command instead of the bare id; for a session
	// with no turns, point to the folder's earlier ones (see resumeHint).
	let resumeHintPrinted = false;
	const printResumeHint = () => {
		if (resumeHintPrinted) return;
		const here = resolve(result.cwd);
		const earlier = listSessionSummaries().some(
			(s) => s.msgCount > 0 && s.id !== result.session.id && s.cwd && resolve(s.cwd) === here,
		);
		const session = { id: result.session.id, hasMessages: sessionHasMessages(result.session.id) };
		writeLastResume(resumeCommand(session, earlier));
		const line = resumeHint(session, earlier);
		if (!line) return;
		resumeHintPrinted = true;
		process.stdout.write(`${line}\n`);
	};

	// Ends the session: save it, close what was opened,
	// hand the terminal back with `stopScreen`, say how to resume, exit.
	const endSession = (stopScreen: () => void) => {
		saveSession(result.session);
		if (result.hooks) {
			void runHooksForEvent(result.hooks, {
				event: "SessionEnd",
				cwd: result.cwd,
				sessionId: result.session.id,
				payload: { reason: "quit" },
			});
		}
		void drainProjectCheckpointWriters(2_500)
			.finally(() => closeMcpConnections(result.mcpResult.connections))
			.then(async () => {
				// Stop drawing first, so the screen does not repaint over the resume hint.
				stopScreen();
				printResumeHint();
				await new Promise((resolve) => setTimeout(resolve, 60));
				process.exit(0);
			});
	};
	const onPasteImage = (): Promise<ClipboardPasteResult> => saveClipboardImageToTempFile();

	await runPiFrontEnd({
		result,
		version: args.version,
		initialPrompt: args.initialPrompt,
		daemonUrl,
		daemonToken,
		quit: endSession,
		onPasteImage,
		// React unmounts the tree on a render error, and the app would go on taking keys against a model that no
		// longer updates: a frozen screen is worse than ending, and the session is saved as it goes.
		onError: (error) => {
			reportFatal("render error", error, `Your session is saved: cast --resume=${result.session.id}`);
			process.exit(1);
		},
	});
}
