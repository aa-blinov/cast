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

	const ensure = (): TuiAltScreen => {
		if (!screen) {
			screen = new TuiAltScreen(makeTerminal(), false, undefined, { mouse: false });
			screen.start();
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
			hide();
			screen?.stop();
			screen = undefined;
			for (const line of logged) console.log(line);
		},
	};
}
