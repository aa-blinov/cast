import { format } from "node:util";
import { type Component, type OverlayHandle, TuiAltScreen } from "@earendil-works/pi-tui";
import type { Pickers, PickOption, PickOptions } from "../pickers/types.ts";
import { makeTerminal } from "./ascii.ts";
import { MultiModal, OptionModal, Sheet, StatusModal, TextModal } from "./modals.ts";

/**
 * What the person sees before the app mounts: a progress line while it starts,
 * and the onboarding questions (provider, model, persona, trust). One screen
 * for all of them, handed back in `done`, so a run of questions does not flash
 * the terminal between each.
 */
export function createStartupUi(): {
	pickers: Pickers;
	progress: (text: string) => void;
	hide: () => void;
	done: () => void;
} {
	let screen: TuiAltScreen | undefined;
	let overlay: OverlayHandle | undefined;
	let ticker: NodeJS.Timeout | undefined;
	const logged: string[] = [];
	// What the program prints while the screen is up would be thrown away with it (an error before an exit,
	// say): hold it, and print it on the normal screen once the terminal is handed back.
	const deferred: Array<{ stream: "log" | "warn" | "error"; text: string }> = [];
	const original = { log: console.log, warn: console.warn, error: console.error };
	const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 } as const;
	const onSignals: Array<[string, () => void]> = [];

	const leave = () => {
		if (!screen) return;
		hide();
		try {
			screen.stop();
		} catch {
			// already stopped
		}
		screen = undefined;
		console.log = original.log;
		console.warn = original.warn;
		console.error = original.error;
		process.off("exit", leave);
		for (const [signal, handler] of onSignals.splice(0)) process.off(signal, handler);
		for (const { stream, text } of deferred.splice(0)) original[stream](text);
	};

	const ensure = (): TuiAltScreen => {
		if (!screen) {
			screen = new TuiAltScreen(makeTerminal(), false, undefined, { mouse: false });
			screen.start();
			for (const stream of ["log", "warn", "error"] as const) {
				console[stream] = (...args: unknown[]) => {
					deferred.push({ stream, text: format(...args) });
				};
			}
			// Whatever ends the process while the screen is up (`process.exit` in a failed start, Esc on a
			// first-run question, a signal) must hand the terminal back first.
			process.once("exit", leave);
			for (const [signal, number] of Object.entries(signalNumbers)) {
				const handler = () => {
					leave();
					process.exit(128 + number);
				};
				onSignals.push([signal, handler]);
				process.once(signal, handler);
			}
		}
		return screen;
	};

	const hide = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		overlay?.hide();
		overlay = undefined;
	};

	const show = (component: Component, nonCapturing = false, columns?: number) => {
		const tui = ensure();
		hide();
		overlay = tui.showOverlay(nonCapturing ? component : new Sheet(component), {
			anchor: "center",
			width: columns ?? (nonCapturing ? "80%" : "100%"),
			maxHeight: "80%",
			nonCapturing,
		});
		tui.requestRender();
	};

	const ask = <T>(make: (done: (value: T) => void) => Component): Promise<T> =>
		new Promise((resolve) => {
			show(
				make((value) => {
					hide();
					resolve(value);
				}),
			);
		});

	const pickers: Pickers = {
		pickOption<T>(options: PickOption<T>[], opts?: PickOptions<T>): Promise<T | null> {
			if (options.length === 0) return Promise.resolve(null);
			return ask<T | null>((done) => new OptionModal(options, opts, done));
		},
		promptText(label, defaultValue, placeholder, error) {
			return ask<string | null>((done) => new TextModal({ label, defaultValue, placeholder, error }, done));
		},
		pickMulti<T>(options: PickOption<T>[], opts?: PickOptions<T> & { initialSelected?: T[] }): Promise<T[] | null> {
			if (options.length === 0) return Promise.resolve([]);
			const initial = new Set<number>();
			for (const value of opts?.initialSelected ?? []) {
				const i = options.findIndex((o) => o.value === value);
				if (i >= 0) initial.add(i);
			}
			return ask<number[] | null>((done) => new MultiModal(options, opts, initial, done)).then((indices) =>
				indices === null ? null : indices.map((i) => options[i]?.value as T),
			);
		},
		log(text) {
			logged.push(text);
		},
	};

	return {
		pickers,
		progress(text) {
			const modal = new StatusModal(text);
			show(modal, true, StatusModal.widthFor(text));
			ticker = setInterval(() => {
				modal.tick();
				screen?.requestRender();
			}, 120);
		},
		hide,
		done() {
			leave();
			for (const line of logged) console.log(line);
		},
	};
}
