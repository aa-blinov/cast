import { ProcessTerminal, type TerminalColors, TuiAltScreen } from "@earendil-works/pi-tui";
import { createElement, useEffect } from "react";
import type { StartupResult } from "../core/startup.ts";
import { setSuspendHook } from "../core/stdin-manager.ts";
import { type AppModel, type AppModelProps, useAppModel } from "../ui/app-model.ts";
import { gradientAnsi } from "../ui/gradient.ts";
import type { ClipboardPasteResult } from "../ui/readClipboardImage.ts";
import { theme } from "../ui/themes/index.ts";
import { PiApp } from "./app.ts";
import { createStore, mountHeadless } from "./headless.ts";
import { applyUserKeybindings } from "./keys.ts";
import { paint } from "./paint.ts";
import { setSurfaces } from "./surface.ts";

export interface PiFrontEndOptions {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	daemonUrl?: string;
	daemonToken?: string;
	/** Ends the session: the caller saves it, closes what it opened and exits, after `stopScreen` hands the terminal back. */
	quit: (stopScreen: () => void) => void;
	/** Saves the clipboard's image and says where (Ctrl+G). */
	onPasteImage?: () => Promise<ClipboardPasteResult>;
	/** Writes what could not be drawn (a React error in the model). */
	onError: (error: Error) => void;
}

function ModelHost(props: { model: AppModelProps; publish: (model: AppModel) => void }) {
	const model = useAppModel(props.model);
	useEffect(() => {
		props.publish(model);
	});
	return null;
}

/**
 * The TUI on pi-tui: an alternate screen whose viewport the application owns,
 * so a repaint cannot move what the person is reading. The app's behaviour is
 * `useAppModel`'s, running in a headless React root; this draws what it returns.
 */
export async function runPiFrontEnd(options: PiFrontEndOptions): Promise<void> {
	applyUserKeybindings();
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, {
		// The wheel and drag-to-select belong to the app in the alternate screen; a
		// terminal's own selection then needs Shift held. CAST_NO_MOUSE=1 leaves the
		// mouse to the terminal, at the price of scrolling by keyboard only.
		mouse: process.env.CAST_NO_MOUSE !== "1",
		wheelScrollLines: "auto",
		scrollToEndIndicator: () => paint(" ↓ newest ", { color: theme().accent, bold: true }),
	});
	const store = createStore<AppModel>();
	let root: { unmount: () => void } | undefined;
	const stopScreen = () => {
		app.dispose();
		root?.unmount();
		tui.stop();
	};
	const quit = () => options.quit(stopScreen);
	const home = process.env.HOME ?? "";
	const where =
		options.result.cwd.startsWith(home) && home ? `~${options.result.cwd.slice(home.length)}` : options.result.cwd;
	const muted = { color: theme().muted };
	const banner = [
		`${gradientAnsi(`cast v${options.version}`)}${paint(`  ·  ${options.result.persona.label}  ·  ${options.result.session.model}  ·  ${where}`, muted)}`,
		paint("/ commands · /settings · Esc Esc stops a turn · PageUp scrolls · Ctrl+C twice quits", muted),
		"",
	];
	const app = new PiApp(tui, quit, options.onPasteImage, banner);
	store.subscribe((model) => app.update(model));

	setSuspendHook(async (run) => {
		tui.stop({ preserveScreen: true });
		try {
			await run();
		} finally {
			tui.start();
		}
	});

	// A crash or a signal must not leave the terminal in the alternate screen with
	// raw input: hand it back first, whatever ends the process.
	const restore = () => {
		try {
			tui.stop();
		} catch {
			// already stopped
		}
	};
	process.once("exit", restore);
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			restore();
			process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
		});
	}

	tui.start();
	app.start();
	// Ask the terminal what its colours are, so bands and highlights fit it; a slow link may answer late.
	const useSurfaces = (colors: TerminalColors) => {
		setSurfaces(colors);
		app.repaint();
	};
	void tui.queryTerminalColors({ timeoutMs: 400, onLateReply: useSurfaces }).then(useSurfaces);
	root = mountHeadless(
		createElement(ModelHost, {
			model: {
				result: options.result,
				version: options.version,
				initialPrompt: options.initialPrompt,
				onQuit: quit,
				onThemeChange: () => app.repaint(),
				onRepaintHistory: () => app.repaint(),
				daemonUrl: options.daemonUrl,
				daemonToken: options.daemonToken,
			},
			publish: (model) => store.set(model),
		}),
		options.onError,
	);
	// The process ends through `quit`.
	await new Promise<never>(() => {});
}
