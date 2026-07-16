import { useRef, useSyncExternalStore } from "react";
import type { StatusBarConfig } from "../core/settings.ts";
import type { Pickers, PickOption, PickOptions } from "../pickers/types.ts";
import type { StatusBarSegment } from "./statusbar.tsx";

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
			kind: "statusbar";
			segments: readonly StatusBarSegment[];
			initialConfig: StatusBarConfig;
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
 * live Ink tree. A naive implementation would call Ink's `render()` again
 * for each prompt, which mounts a second, independent Ink instance fighting
 * the already-running App/Composer for stdin and raw mode — see the history
 * of this file (pickers/ink.tsx) for why that's unsafe post-mount. Instead,
 * `pickOption`/`promptText` here just publish a request; App renders the
 * matching modal inline and resolves it via the `resolve` callback.
 */
function createModalBridge(onLog: (text: string) => void): ModalBridge {
	let current: ModalRequest | null = null;
	const listeners = new Set<() => void>();

	const setRequest = (req: ModalRequest | null): void => {
		current = req;
		for (const listener of listeners) listener();
	};

	const pickers: Pickers = {
		pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null> {
			if (options.length === 0) return Promise.resolve(null);
			return new Promise((resolvePromise) => {
				setRequest({
					kind: "option",
					options: options as PickOption<unknown>[],
					opts,
					resolve: (value) => {
						setRequest(null);
						resolvePromise(value as T | null);
					},
				});
			});
		},
		promptText(label: string, defaultValue?: string, placeholder?: string, error?: string): Promise<string | null> {
			return new Promise((resolvePromise) => {
				setRequest({
					kind: "text",
					label,
					defaultValue,
					placeholder,
					error,
					resolve: (value) => {
						setRequest(null);
						resolvePromise(value);
					},
				});
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
				setRequest({
					kind: "multi",
					options: options as PickOption<unknown>[],
					opts,
					initialSelected: initialIndices,
					resolve: (indices) => {
						setRequest(null);
						if (indices === null) resolvePromise(null);
						else resolvePromise(indices.map((i) => options[i]!.value));
					},
				});
			});
		},
		pickStatusBar(
			segments: readonly StatusBarSegment[],
			initialConfig: StatusBarConfig,
		): Promise<StatusBarConfig | null> {
			return new Promise((resolvePromise) => {
				setRequest({
					kind: "statusbar",
					segments,
					initialConfig,
					resolve: (config) => {
						setRequest(null);
						resolvePromise(config);
					},
				});
			});
		},
		status(label: string): () => void {
			// Callers always dismiss the spinner before opening the next modal
			// (in a finally, or right after the awaited step), so a plain clear is
			// safe — nothing has replaced it by the time dismiss runs.
			setRequest({ kind: "status", label });
			return () => setRequest(null);
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
