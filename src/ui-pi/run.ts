import { type TerminalColors, TuiAltScreen } from "@earendil-works/pi-tui";
import { createElement, useEffect } from "react";
import type { StartupResult } from "../core/startup.ts";
import { setSuspendHook } from "../core/stdin-manager.ts";
import { type AppModel, type AppModelProps, useAppModel } from "../ui/app-model.ts";
import { copyToClipboard } from "../ui/clipboard.ts";
import type { ClipboardPasteResult } from "../ui/readClipboardImage.ts";
import { theme } from "../ui/themes/index.ts";
import { PiApp } from "./app.ts";
import { makeTerminal } from "./ascii.ts";
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
	const terminal = makeTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, {
		// The wheel and drag-to-select belong to the app in the alternate screen; a
		// terminal's own selection then needs Shift held. CAST_NO_MOUSE=1 leaves the
		// mouse to the terminal, at the price of scrolling by keyboard only.
		mouse: process.env.CAST_NO_MOUSE !== "1",
		wheelScrollLines: "auto",
		// Selecting text copies it: through the machine's clipboard tool when there is one (and not over SSH,
		// where it would be the remote machine's), else the terminal's. The bare terminal write says "Copied!"
		// whether or not anything arrived.
		copySelection: async (text) => {
			const copied = copyToClipboard(text);
			return copied.ok ? true : copied.error;
		},
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
	const app = new PiApp(tui, quit, options.version, options.onPasteImage);
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
	// Raw input means Ctrl+C is a key, not a signal: these come from outside (kill, a supervisor, a closed
	// terminal), and the default action for each would end the process with the screen still taken over.
	const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 } as const;
	for (const [signal, number] of Object.entries(signalNumbers)) {
		process.once(signal, () => {
			restore();
			process.exit(128 + number);
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
