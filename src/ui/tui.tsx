import { Box, render, Text } from "ink";
import type { JSX } from "react";
import { CAST_BANNER } from "../core/help.ts";
import { runHooksForEvent } from "../core/hooks.ts";
import { closeMcpConnections } from "../core/mcp.ts";
import { drainProjectCheckpointWriters } from "../core/memory.ts";
import { saveSession } from "../core/session.ts";
import { type ParsedArgs, runStartup } from "../core/startup.ts";
import { cancelActiveDecxprQuery, suspendAndRun } from "../core/stdin-manager.ts";
import { inkPickers } from "../pickers/ink.tsx";
import type { Pickers } from "../pickers/types.ts";
import { daemonBaseUrl, readLiveServerState } from "../server/daemon-state.ts";
import { App } from "./App.tsx";
import { gradientBanner } from "./gradient.ts";
import { saveClipboardImageToTempFile } from "./readClipboardImage.ts";
import { Spinner } from "./Spinner.tsx";
import { loadTheme } from "./themes/index.ts";

function StartupLoader({ text }: { text: string }): JSX.Element {
	return (
		<Box>
			<Spinner />
			<Text> {text}</Text>
		</Box>
	);
}

/**
 * TUI entry point. Thin wrapper over runStartup plus
 * mounting the Ink App. Onboarding picker calls happen before render() so
 * they don't fight the long-lived App for stdin — see pickers/ink.tsx.
 *
 * runStartup can take a few seconds on the fast path too (silent model
 * re-check, MCP server handshakes) — with nothing mounted yet, that's a
 * blank terminal with no sign anything is happening. Mount a tiny spinner
 * instance first, feed it runStartup's progress text via rerender(), then
 * swap to the real App once it resolves.
 */
export async function runTui(args: ParsedArgs, daemonToken?: string): Promise<void> {
	// Node 22 has no global EventSource; the TUI pulls undici's experimental
	// build to receive the daemon's SSE stream. undici emits a one-time
	// "EventSource is experimental" (code UNDICI-ES) warning on first use —
	// it's noisy and meaningless for us, so suppress just that code. Other
	// warnings are replayed to the original listener so nothing else is lost.
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
	let loader: ReturnType<typeof render> | null = null;
	const showLoader = (text: string) => {
		if (loader) loader.rerender(<StartupLoader text={text} />);
		else loader = render(<StartupLoader text={text} />);
	};
	const hideLoader = () => {
		// unmount() alone leaves the last drawn frame sitting on screen — Ink's
		// own log-update only erases previous output on the *next* render, and
		// there isn't one once this instance is gone. clear() actively erases
		// those lines (see ink.js/log-update.js); has to run first.
		loader?.clear();
		loader?.unmount();
		loader = null;
	};

	// inkPickers renders its own onboarding UI via a fresh render() call per
	// prompt — mounting two Ink instances against the same stdout at once is
	// unsupported (Ink just warns and reuses one, and unmount() on either
	// then tears down both — see pickerBridge.ts for the same problem
	// post-mount). Hide the loader right before any picker shows; the next
	// onProgress call remounts it once runStartup moves past the prompt.
	const pickersWithLoaderHandoff: Pickers = {
		...inkPickers,
		pickOption: (options, opts) => {
			hideLoader();
			return inkPickers.pickOption(options, opts);
		},
		promptText: (label, defaultValue, placeholder) => {
			hideLoader();
			return inkPickers.promptText(label, defaultValue, placeholder);
		},
	};

	// Load the saved theme before any UI — the startup spinner reads gradient
	// endpoints from the active theme.
	loadTheme(args.settings.theme);

	showLoader("Starting cast...");
	const result = await runStartup(args, pickersWithLoaderHandoff, showLoader);
	hideLoader();

	console.log(gradientBanner(CAST_BANNER, args.version));

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

	const onQuit = () => {
		saveSession(result.session);
		if (result.hooks) {
			void runHooksForEvent(result.hooks, {
				event: "SessionEnd",
				cwd: result.cwd,
				sessionId: result.session.id,
				payload: { reason: "quit" },
			});
		}
		// Stop a pending \x1b[6n before process.exit tears raw mode down — the
		// terminal's \x1b[<row>;<col>R reply would otherwise be echoed into the
		// shell as garbage once the process is gone. Give any already-sent reply
		// a moment to arrive while raw mode is still on (InputParser drops it),
		// then exit. Also clear the screen so the last TUI frame (banner,
		// composer box, status bar) doesn't linger under the shell prompt.
		cancelActiveDecxprQuery();
		void drainProjectCheckpointWriters(2_500)
			.finally(() => closeMcpConnections(result.mcpResult.connections))
			.then(async () => {
				process.stdout.write("\x1b[2J\x1b[H");
				await new Promise((resolve) => setTimeout(resolve, 60));
				process.exit(0);
			});
	};
	const onPasteImage = async (): Promise<string | null> => {
		const filePath = await saveClipboardImageToTempFile();
		return filePath;
	};

	// Repaint the banner with the current theme's gradient. Uses suspendAndRun
	// to temporarily pause Ink so raw stdout writes don't fight its managed
	// frame. Clears the whole screen (+ scrollback) first: the banner scrolled
	// into scrollback as soon as the conversation grew, so a relative
	// cursor-up from the frame bottom would land mid-transcript and clobber
	// whatever was there instead of the banner. App.onThemeChange replays the
	// full history below the fresh banner afterwards (see its Static key
	// bump), so nothing on screen is actually lost.
	//
	// `preserveScrollback` (light resync — resize, settleResync after a resume,
	// focus regain): the clear (\x1b[2J) must NOT wipe scrollback so the user's
	// scroll position survives. But the banner is printed to stdout (outside
	// Ink's tree), so a bare light clear would leave it erased — reprint it
	// without the scrollback wipe.
	const onRepaintBanner = async (preserveScrollback?: boolean) => {
		await suspendAndRun(async () => {
			if (!preserveScrollback) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
			process.stdout.write(`${gradientBanner(CAST_BANNER, args.version)}\n`);
		});
	};

	const { waitUntilExit } = render(
		<App
			result={result}
			version={args.version}
			initialPrompt={args.initialPrompt}
			onPasteImage={onPasteImage}
			onQuit={onQuit}
			onRepaintBanner={onRepaintBanner}
			daemonUrl={daemonUrl}
			daemonToken={daemonToken}
		/>,
		{
			// Ctrl+C is handled by the Composer (double-press confirmation, see
			// handleExitRequest). Ink's default exitOnCtrlC would race it: on
			// terminals without the Kitty protocol Ctrl+C arrives as raw \x03,
			// which Ink's own input handler turns into an instant unmount before
			// the composer's confirmation ever shows.
			exitOnCtrlC: false,
			// Only repaint lines that actually changed, and move the cursor with
			// one combined jump instead of ansi-escapes' eraseLines() default
			// (N erase-line calls interleaved with N-1 separate `\x1b[1A` hops —
			// see useTerminalResync's coalesceEraseLines for the terminals that
			// choke on that repeated-identical-escape pattern). Ink's own
			// documented fix for the same class of problem ("reduce flickering
			// ... for frequently updating UIs"); coalesceEraseLines stays as a
			// belt-and-suspenders backstop for whatever incremental mode's own
			// write shape doesn't happen to cover.
			incrementalRendering: true,
			// Was raised to 60 for a more responsive composer once border
			// duplication was fixed (coalescing + incremental rendering above).
			// Reverted to Ink's default: doubling write frequency to the
			// terminal doubled the odds of hitting the same class of
			// desync/flicker on slow or unusual terminals (SSH with high RTT,
			// tmux, mobile emulators) that the rest of the resync machinery
			// exists to paper over.
			maxFps: 30,
		},
	);

	// Ink's suspendTerminal (needed by execBash to hand the terminal to child
	// processes) is wired inside <App> via the public useApp() hook — see
	// App.tsx. It used to be wired here by digging into ink's internal
	// instances.js at runtime, which always failed in the release bundle
	// (ink is inlined by esbuild; there's no node_modules/ink to resolve).

	await waitUntilExit();
	saveSession(result.session);
	if (result.hooks) {
		await runHooksForEvent(result.hooks, {
			event: "SessionEnd",
			cwd: result.cwd,
			sessionId: result.session.id,
			payload: { reason: "exit" },
		});
	}
	await closeMcpConnections(result.mcpResult.connections);
}
