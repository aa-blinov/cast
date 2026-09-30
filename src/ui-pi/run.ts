import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createElement, useEffect } from "react";
import type { StartupResult } from "../core/startup.ts";
import { setSuspendHook } from "../core/stdin-manager.ts";
import { type AppModel, type AppModelProps, useAppModel } from "../ui/app-model.ts";
import { theme } from "../ui/themes/index.ts";
import { PiApp } from "./app.ts";
import { createStore, mountHeadless } from "./headless.ts";
import { paint } from "./paint.ts";

export interface PiFrontEndOptions {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	daemonUrl?: string;
	daemonToken?: string;
	/** Ends the session: the caller saves it, closes what it opened and exits, after `stopScreen` hands the terminal back. */
	quit: (stopScreen: () => void) => void;
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
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, {
		mouse: true,
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
	const app = new PiApp(tui, quit);
	store.subscribe((model) => app.update(model));

	setSuspendHook(async (run) => {
		tui.stop({ preserveScreen: true });
		try {
			await run();
		} finally {
			tui.start();
		}
	});

	tui.start();
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
