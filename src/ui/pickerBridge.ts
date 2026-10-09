import { useRef, useSyncExternalStore } from "react";
import type { StatusBarConfig } from "../core/settings.ts";
import type { LiveView, Pickers, PickOption, PickOptions, SettingFollowUp, SettingsForm } from "../pickers/types.ts";
import type { StatusBarSegment } from "./statusbar.ts";

export type ModalRequest =
	| {
			kind: "option";
			options: PickOption<unknown>[];
			opts?: PickOptions;
			resolve: (value: unknown) => void;
	  }
	| {
			kind: "text";
			label: string;
			defaultValue?: string;
			placeholder?: string;
			error?: string;
			resolve: (value: string | null) => void;
	  }
	| {
			kind: "multi";
			options: PickOption<unknown>[];
			opts?: PickOptions;
			initialSelected: Set<number>;
			resolve: (value: number[] | null) => void;
	  }
	| {
			kind: "status";
			label: string;
	  }
	| {
			kind: "settings";
			form: SettingsForm;
			resolve: (followUp: SettingFollowUp | null) => void;
	  }
	| {
			kind: "view";
			view: LiveView;
			resolve: () => void;
	  }
	| {
			kind: "statusbar";
			segments: readonly StatusBarSegment[];
			initialConfig: StatusBarConfig;
			/** Heading of the list, and whether each row can sit on the left or the right (the header has one side). */
			opts?: { title?: string; sides?: boolean };
			resolve: (config: StatusBarConfig | null) => void;
	  };

interface ModalBridge {
	pickers: Pickers;
	subscribe: (listener: () => void) => () => void;
	getRequest: () => ModalRequest | null;
}

/**
 * Bridges the imperative Pickers interface (called from deep inside async
 * command handlers, e.g. /model, /permissions, confirmBash) into the single
 * running app. `pickOption`/`promptText` here just publish a request; the
 * front end draws the matching modal and resolves it via the `resolve` callback.
 */
export function createModalBridge(onLog: (text: string) => void): ModalBridge {
	// Questions that have the keyboard, newest on top. A second one (a permission asked while a settings
	// screen is open) is shown at once and the first comes back once it is answered; neither is lost.
	const stack: ModalRequest[] = [];
	// The progress box of a slow step: shown only while no question is.
	let progress: ModalRequest | null = null;
	let current: ModalRequest | null = null;
	const listeners = new Set<() => void>();

	const publish = (): void => {
		current = stack.at(-1) ?? progress;
		for (const listener of listeners) listener();
	};

	const open = (request: ModalRequest): void => {
		stack.push(request);
		publish();
	};

	/** Takes a request off the stack, wherever it is; false when it already was (a second answer, a stale one). */
	const close = (request: ModalRequest): boolean => {
		const at = stack.indexOf(request);
		if (at < 0) return false;
		stack.splice(at, 1);
		publish();
		return true;
	};

	const pickers: Pickers = {
		pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null> {
			if (options.length === 0 || opts?.signal?.aborted) return Promise.resolve(null);
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "option",
					options: options as PickOption<unknown>[],
					opts,
					resolve: (value) => {
						opts?.signal?.removeEventListener("abort", onAbort);
						if (close(request)) resolvePromise(value as T | null);
					},
				};
				const onAbort = () => request.resolve(null);
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				open(request);
			});
		},
		promptText(
			label: string,
			defaultValue?: string,
			placeholder?: string,
			error?: string,
			opts?: { signal?: AbortSignal },
		): Promise<string | null> {
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "text",
					label,
					defaultValue,
					placeholder,
					error,
					resolve: (value) => {
						opts?.signal?.removeEventListener("abort", onAbort);
						if (close(request)) resolvePromise(value);
					},
				};
				const onAbort = () => request.resolve(null);
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				open(request);
			});
		},
		pickMulti<T>(options: PickOption<T>[], opts?: PickOptions & { initialSelected?: T[] }): Promise<T[] | null> {
			if (options.length === 0) return Promise.resolve([]);
			const initialIndices = new Set<number>();
			if (opts?.initialSelected) {
				for (const val of opts.initialSelected) {
					const i = options.findIndex((o) => o.value === val);
					if (i >= 0) initialIndices.add(i);
				}
			}
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "multi",
					options: options as PickOption<unknown>[],
					opts,
					initialSelected: initialIndices,
					resolve: (indices) => {
						opts?.signal?.removeEventListener("abort", onAbort);
						if (!close(request)) return;
						if (indices === null) resolvePromise(null);
						else resolvePromise(indices.map((i) => options[i]!.value));
					},
				};
				const onAbort = () => request.resolve(null);
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				open(request);
			});
		},
		pickStatusBar(
			segments: readonly StatusBarSegment[],
			initialConfig: StatusBarConfig,
			opts?: { title?: string; sides?: boolean },
		): Promise<StatusBarConfig | null> {
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "statusbar",
					segments,
					initialConfig,
					opts,
					resolve: (config) => {
						if (close(request)) resolvePromise(config);
					},
				};
				open(request);
			});
		},
		settings(form: SettingsForm): Promise<SettingFollowUp | null> {
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "settings",
					form,
					resolve: (followUp) => {
						if (close(request)) resolvePromise(followUp);
					},
				};
				open(request);
			});
		},
		viewLive(view: LiveView): Promise<void> {
			return new Promise((resolvePromise) => {
				const request: ModalRequest = {
					kind: "view",
					view,
					resolve: () => {
						if (close(request)) resolvePromise();
					},
				};
				open(request);
			});
		},
		status(label: string): () => void {
			const request: ModalRequest = { kind: "status", label };
			progress = request;
			publish();
			// Only its own box is taken down: a later step's must stay.
			return () => {
				if (progress !== request) return;
				progress = null;
				publish();
			};
		},
		log(text: string): void {
			onLog(text);
		},
	};

	return {
		pickers,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getRequest: () => current,
	};
}

/** React binding for createModalBridge — one bridge per App lifetime. */
export function useModalBridge(onLog: (text: string) => void): { pickers: Pickers; request: ModalRequest | null } {
	const onLogRef = useRef(onLog);
	onLogRef.current = onLog;
	const bridgeRef = useRef<ModalBridge | null>(null);
	if (!bridgeRef.current) bridgeRef.current = createModalBridge((text) => onLogRef.current(text));
	const bridge = bridgeRef.current;
	const request = useSyncExternalStore(bridge.subscribe, bridge.getRequest);
	return { pickers: bridge.pickers, request };
}
