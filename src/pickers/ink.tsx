import { Box, render, Text, useInput } from "ink";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { theme } from "../ui/themes/index.ts";
import { score } from "./match.ts";
import type { Pickers, PickOption, PickOptions } from "./types.ts";

// Cap on option rows rendered at once. Without a window a long list (models,
// sessions, personas) grows the live region past the terminal height, where
// Ink's log-update erase math breaks and every redraw stacks a duplicate
// frame — the same failure mode ChatLog's clampStreamingBlocks guards against.
const PICKER_MAX_ROWS = 10;

/**
 * Option rows that fit the current terminal. The modal's own chrome (padding,
 * title, optional error block, selected-row description, footer) plus the
 * composer and status bar still rendered below the modal consume ~13 rows —
 * a fixed 10-row window fit a default 24-row terminal but still overflowed
 * shorter ones, resurrecting the duplicate-frame corruption the window
 * exists to prevent. Never fewer than 3 rows so the picker stays usable.
 */
export function pickerViewportRows(terminalRows: number): number {
	return Math.max(3, Math.min(PICKER_MAX_ROWS, terminalRows - 13));
}

export function ModalPicker<T>(props: {
	options: PickOption<T>[];
	opts?: PickOptions;
	onSelect: (value: T) => void;
	onCancel: () => void;
}): JSX.Element {
	const searchable = !!props.opts?.search;
	const [query, setQuery] = useState("");
	const [idx, setIdx] = useState(() =>
		Math.min(Math.max(0, props.opts?.defaultIndex ?? 0), Math.max(0, props.options.length - 1)),
	);

	// Pre-lowered haystacks: label + description + searchText, computed once per
	// options array (keystrokes reuse the same strings). score() expects both
	// sides pre-lowered, so all matching cost is one substring / subsequence
	// pass per option per keystroke.
	const haystacks = useMemo(
		() => props.options.map((o) => `${o.label}\n${o.description ?? ""}\n${o.searchText ?? ""}`.toLowerCase()),
		[props.options],
	);
	const qLower = query.toLowerCase();
	const filtered = useMemo(() => {
		if (qLower.length === 0) return props.options.map((o, i) => ({ o, i }));
		const out: Array<{ o: PickOption<T>; i: number; s: number }> = [];
		props.options.forEach((o, i) => {
			const s = score(haystacks[i] ?? "", qLower);
			if (s >= 0) out.push({ o, i, s });
		});
		out.sort((a, b) => b.s - a.s || a.i - b.i);
		return out;
	}, [props.options, haystacks, qLower]);
	const visibleOptions = filtered.map((f) => f.o);
	const visibleLen = visibleOptions.length;

	// Reset the cursor when the query actually changes — the filtered list is
	// reordered/shrunk, so a kept index would point at an arbitrary row (or
	// past the end). Guarded by a prev-ref so mount keeps defaultIndex and
	// arrow-key renders don't snap the cursor back to the top.
	const prevQueryRef = useRef(qLower);
	useEffect(() => {
		if (prevQueryRef.current !== qLower) {
			prevQueryRef.current = qLower;
			setIdx(0);
		}
	}, [qLower]);

	useInput((input, key) => {
		if (key.upArrow) {
			if (visibleLen === 0) return;
			setIdx((i) => (i - 1 + visibleLen) % visibleLen);
			return;
		}
		if (key.downArrow) {
			if (visibleLen === 0) return;
			setIdx((i) => (i + 1) % visibleLen);
			return;
		}
		if (key.return) {
			if (visibleLen === 0) return;
			const picked = visibleOptions[idx];
			if (!picked || picked.locked) return;
			props.onSelect(picked.value);
			return;
		}
		if (key.escape) {
			props.onCancel();
			return;
		}
		// In searchable mode, `q` (and everything else printable) feeds the query
		// instead of cancelling — otherwise typing "query", "sql", "qa" would
		// close the modal on the first keystroke.
		if (searchable) {
			if (key.backspace || key.delete) {
				setQuery((q) => q.slice(0, -1));
				return;
			}
			if (input && !key.ctrl && !key.meta) {
				// Accept multi-char paste (Cmd+V / Ctrl+V): terminals deliver
				// clipboard contents as one string. Strip control characters
				// and whitespace that bracketed-paste wrappers may add.
				// Also strip DECXCPR cursor-position reports (\x1b[<row>;<col>R):
				// the scroll-resync poll queries them every 500 ms, and once Ink
				// eats the ESC the "[38;1R" tail reads as printable text the user
				// never typed.
				const printable = [...input]
					.filter((c) => c >= " " && c !== String.fromCodePoint(0x7f))
					.join("")
					// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR response format
					.replace(/\x1b?\[\d+(?:;\d+)*R/g, "");
				if (printable) setQuery((q) => q + printable);
				return;
			}
			return;
		}
		// Non-searchable: legacy `q` cancel still works.
		if (input === "q") {
			props.onCancel();
		}
	});
	// Scroll the window to keep the selection visible (same pattern as the
	// composer's command palette). Rows are recomputed per render, so a
	// terminal resize (which repaints the whole tree) resizes the window too.
	const rows = pickerViewportRows(process.stdout.rows || 24);
	const scrollRef = useRef(0);
	const maxScroll = Math.max(0, visibleLen - rows);
	if (scrollRef.current > maxScroll) scrollRef.current = maxScroll;
	if (idx < scrollRef.current) scrollRef.current = idx;
	else if (idx >= scrollRef.current + rows) scrollRef.current = idx - rows + 1;
	const scroll = scrollRef.current;
	const visible = visibleOptions.slice(scroll, scroll + rows);
	const title = props.opts?.title;
	const error = props.opts?.error;
	const searchPlaceholder = props.opts?.search?.placeholder;
	return (
		<Box flexDirection="column" padding={1}>
			{error && (
				<Box marginBottom={1}>
					<Text color={theme().error}>{error}</Text>
				</Box>
			)}
			{title && (
				<Text bold color={theme().accent}>
					{title}
				</Text>
			)}
			{searchable && (
				<Box>
					<Text color={theme().muted}>{"> "}</Text>
					<Text>{query}</Text>
					<Text color="white" inverse>
						{" "}
					</Text>
				</Box>
			)}
			{searchable && !query && searchPlaceholder && (
				<Box marginTop={1}>
					<Text color={theme().muted}>{searchPlaceholder}</Text>
				</Box>
			)}
			{visibleLen === 0 ? (
				<Text color={theme().muted}>No matches</Text>
			) : (
				visible.map((o, vi) => {
					const i = scroll + vi;
					const selected = i === idx;
					const rowColor = o.muted || o.locked ? theme().muted : selected ? theme().accent : "white";
					return (
						// Keyed by absolute index: options are static for the modal's
						// lifetime, and labels can repeat. Rows are hard-truncated to one
						// visual line each — pickerViewportRows budgets by option count,
						// so a long label wrapping to two terminal lines would silently
						// blow that budget on narrow terminals.
						<Box key={i} flexDirection="column">
							<Text wrap="truncate">
								<Text color={selected ? theme().accent : theme().muted}>{selected ? ">" : " "}</Text>{" "}
								<Text color={rowColor} bold={selected && !o.muted && !o.locked}>
									{o.label}
								</Text>
							</Text>
							{selected && o.description && (
								<Text color={theme().muted} wrap="wrap">
									{" "}
									{o.description}
								</Text>
							)}
						</Box>
					);
				})
			)}
			<Box marginTop={1}>
				<Text color={theme().muted}>
					{searchable ? "type to filter" : "up/down select"} · Enter confirm · Esc cancel
					{visibleLen > rows ? ` · ${idx + 1}/${visibleLen}` : ""}
				</Text>
			</Box>
		</Box>
	);
}

export function TextInputModal(props: {
	label: string;
	defaultValue?: string;
	placeholder?: string;
	error?: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}): JSX.Element {
	const [text, setText] = useState(props.defaultValue ?? "");
	useInput((input, key) => {
		if (key.return) {
			props.onSubmit(text);
			return;
		}
		if (key.escape) {
			props.onCancel();
			return;
		}
		if (key.backspace || key.delete) {
			setText((t) => t.slice(0, -1));
			return;
		}
		if (input && !key.ctrl && !key.meta) {
			// Accept multi-char paste (Cmd+V / Ctrl+V): terminals deliver
			// clipboard contents as one string. Strip control characters
			// and whitespace that bracketed-paste wrappers may add.
			// Also strip DECXCPR cursor-position reports (\x1b[<row>;<col>R):
			// the scroll-resync poll queries them every 500 ms, and once Ink
			// eats the ESC the "[38;1R" tail reads as printable text the user
			// never typed.
			const printable = [...input]
				.filter((c) => c >= " " && c !== String.fromCodePoint(0x7f))
				.join("")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: DECXCPR response format
				.replace(/\x1b?\[\d+(?:;\d+)*R/g, "");
			if (printable) setText((t) => t + printable);
		}
	});
	return (
		<Box flexDirection="column" padding={1}>
			{props.error && (
				<Box marginBottom={1}>
					<Text color={theme().error}>{props.error}</Text>
				</Box>
			)}
			<Text bold color={theme().accent}>
				{props.label}
			</Text>
			<Box>
				<Text color={theme().muted}>{"> "}</Text>
				<Text>{text}</Text>
				<Text color="white" inverse>
					{" "}
				</Text>
			</Box>
			{props.placeholder && !text && (
				<Box marginTop={1}>
					<Text color={theme().muted}>{props.placeholder}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text color={theme().muted}>Enter confirm · Esc cancel</Text>
			</Box>
		</Box>
	);
}

export function MultiSelectPicker<T>(props: {
	options: PickOption<T>[];
	opts?: PickOptions;
	initialSelected: Set<number>;
	onConfirm: (selectedIndices: number[]) => void;
	onCancel: () => void;
}): JSX.Element {
	const [idx, setIdx] = useState(() =>
		Math.min(Math.max(0, props.opts?.defaultIndex ?? 0), Math.max(0, props.options.length - 1)),
	);
	const [selected, setSelected] = useState(() => new Set(props.initialSelected));
	useInput((input, key) => {
		if (key.upArrow) {
			setIdx((i) => (i - 1 + props.options.length) % props.options.length);
			return;
		}
		if (key.downArrow) {
			setIdx((i) => (i + 1) % props.options.length);
			return;
		}
		if (input === " ") {
			if (props.options[idx]?.locked) return;
			setSelected((prev) => {
				const next = new Set(prev);
				if (next.has(idx)) next.delete(idx);
				else next.add(idx);
				return next;
			});
			return;
		}
		if (key.return) {
			props.onConfirm([...selected].sort((a, b) => a - b));
			return;
		}
		if (key.escape || input === "q") {
			props.onCancel();
		}
	});
	const rows = pickerViewportRows(process.stdout.rows || 24);
	const scrollRef = useRef(0);
	const maxScroll = Math.max(0, props.options.length - rows);
	if (scrollRef.current > maxScroll) scrollRef.current = maxScroll;
	if (idx < scrollRef.current) scrollRef.current = idx;
	else if (idx >= scrollRef.current + rows) scrollRef.current = idx - rows + 1;
	const scroll = scrollRef.current;
	const visible = props.options.slice(scroll, scroll + rows);
	const title = props.opts?.title;
	return (
		<Box flexDirection="column" padding={1}>
			{title && (
				<Text bold color={theme().accent}>
					{title}
				</Text>
			)}
			{visible.map((o, vi) => {
				const i = scroll + vi;
				const focused = i === idx;
				const checked = selected.has(i);
				// Pack-off / locked rows stay muted even when focused — accent is only the caret.
				const rowColor = o.muted || o.locked ? theme().muted : focused ? theme().accent : "white";
				return (
					<Box key={i} flexDirection="column">
						<Text wrap="truncate">
							<Text color={focused ? theme().accent : theme().muted}>{focused ? ">" : " "}</Text>{" "}
							<Text color={rowColor} bold={focused && !o.muted && !o.locked}>
								{o.locked ? "[-]" : checked ? "[x]" : "[ ]"}
							</Text>{" "}
							<Text color={rowColor} bold={focused && !o.muted && !o.locked}>
								{o.label}
							</Text>
						</Text>
						{focused && o.description && (
							<Text color={theme().muted} wrap="wrap">
								{" "}
								{o.description}
							</Text>
						)}
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme().muted}>
					up/down navigate · Space toggle · Enter confirm · Esc cancel
					{props.options.length > rows ? ` · ${idx + 1}/${props.options.length}` : ""}
				</Text>
			</Box>
		</Box>
	);
}

/**
 * Standalone Ink-backed Pickers implementation. Each call spins up its own
 * short-lived Ink instance (render → wait for selection → unmount).
 *
 * Only safe to use *before* the main App is mounted (i.e. during
 * runStartup's onboarding, per tui.tsx) — once the long-lived App is
 * rendering, use the bridged pickers from ui/pickerBridge.ts instead, which
 * render the same ModalPicker/TextInputModal inside the existing Ink tree
 * instead of racing it for stdin/raw-mode with a second render() call.
 */
export const inkPickers: Pickers = {
	pickOption<T>(options: PickOption<T>[], opts?: PickOptions): Promise<T | null> {
		if (options.length === 0) return Promise.resolve(null);
		return new Promise((resolve) => {
			const instance = render(
				<ModalPicker
					options={options}
					opts={opts}
					onSelect={(v) => {
						resolve(v);
						instance.unmount();
					}}
					onCancel={() => {
						resolve(null);
						instance.unmount();
					}}
				/>,
			);
		});
	},

	promptText(label: string, defaultValue?: string, placeholder?: string, error?: string): Promise<string | null> {
		return new Promise((resolve) => {
			const instance = render(
				<TextInputModal
					label={label}
					defaultValue={defaultValue}
					placeholder={placeholder}
					error={error}
					onSubmit={(v) => {
						resolve(v);
						instance.unmount();
					}}
					onCancel={() => {
						resolve(null);
						instance.unmount();
					}}
				/>,
			);
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
		return new Promise((resolve) => {
			const instance = render(
				<MultiSelectPicker
					options={options}
					opts={opts}
					initialSelected={initialIndices}
					onConfirm={(indices) => {
						resolve(indices.map((i) => options[i]!.value));
						instance.unmount();
					}}
					onCancel={() => {
						resolve(null);
						instance.unmount();
					}}
				/>,
			);
		});
	},

	log(text: string): void {
		console.log(text);
	},
};
