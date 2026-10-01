import {
	type Component,
	decodeKittyPrintable,
	type Focusable,
	Input,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "../core/settings.ts";
import { score } from "../pickers/match.ts";
import type { LiveView, PickOption, PickOptions, SettingFollowUp, SettingRow, SettingsForm } from "../pickers/types.ts";
import type { ModalRequest } from "../ui/pickerBridge.ts";
import { railMuted } from "../ui/span-style.ts";
import type { StatusBarSegment } from "../ui/statusbar.ts";
import { theme } from "../ui/themes/index.ts";
import { band, paint } from "./paint.ts";
import { surfaceHover } from "./surface.ts";

// Every question the app asks the person (a choice, a line of text, a set of
// toggles, a live view) is a ModalRequest from the picker bridge; here each
// kind becomes a framed overlay that takes the keyboard until it answers.

const POLL_MS = 1000;
const PICKER_MAX_ROWS = 12;

/** Typed text in `data`: one key or a paste, without the control sequences around it. */
export function printable(data: string): string {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.includes("\x1b")) return "";
	return [...data].filter((c) => c >= " " && c !== "\x7f").join("");
}

function pickerRows(): number {
	return Math.max(3, Math.min(PICKER_MAX_ROWS, (process.stdout.rows || 24) - 10));
}

const SHEET_MAX_WIDTH = 104;

/**
 * Lays a modal over the whole width of the screen: the box itself is centred and
 * capped (a settings list stretched over 200 columns is not readable), and the
 * columns either side are blanked, so no half a word of the transcript shows
 * beside it.
 */
export class Sheet implements Component, Focusable {
	constructor(private readonly inner: Component) {}

	get focused(): boolean {
		return (this.inner as Partial<Focusable>).focused === true;
	}

	set focused(value: boolean) {
		if ("focused" in this.inner) (this.inner as Focusable).focused = value;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}

	render(width: number): string[] {
		const box = Math.min(width, SHEET_MAX_WIDTH);
		const left = Math.floor((width - box) / 2);
		return this.inner.render(box).map((line) => {
			const right = Math.max(0, width - left - visibleWidth(line));
			return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
		});
	}
}

/** A titled box round `body`, every row padded so it covers what lies under the overlay. */
export function frame(title: string | undefined, body: string[], footer: string, width: number): string[] {
	const inner = Math.max(10, width - 4);
	const edge = (text: string) => paint(text, { color: railMuted(), exact: true });
	const head = title ? ` ${truncateToWidth(title, Math.max(4, inner - 4), "…")} ` : "";
	const top =
		edge("╭─") + paint(head, { bold: true }) + edge(`${"─".repeat(Math.max(0, inner + 1 - visibleWidth(head)))}╮`);
	const row = (line: string) => {
		const cut = truncateToWidth(line, inner, "…");
		return `${edge("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${edge("│")}`;
	};
	return [top, ...body.map(row), row(paint(footer, { color: theme().muted })), edge(`╰${"─".repeat(inner + 2)}╯`)];
}

/** One choice: the highlighted one sits on a band the width of the box, so the eye finds it. */
function choiceRow(
	prefix: string,
	label: string,
	inner: number,
	o: { selected: boolean; color?: string; bold?: boolean; hint?: string },
): string {
	const colors = theme();
	const bg = o.selected ? surfaceHover() : undefined;
	const width = Math.max(10, inner);
	let text =
		paint(prefix, { color: o.selected ? colors.accent : colors.muted, bg }) +
		paint(truncateToWidth(label, Math.max(4, width - visibleWidth(prefix)), "…"), {
			color: o.color,
			bold: o.selected && o.bold !== false,
			bg,
		});
	if (o.hint) {
		// The value sits against the right edge, quiet; it gives way when the label needs the room.
		const room = width - visibleWidth(text) - 2;
		if (room >= 4) {
			const hint = truncateToWidth(o.hint, room, "…");
			const gap = paint(" ".repeat(width - visibleWidth(text) - visibleWidth(hint)), { bg });
			text += gap + paint(hint, { color: colors.muted, bg });
		}
	}
	return bg ? band(text, width, bg) : text;
}

function keepVisible(idx: number, scroll: number, rows: number, length: number): number {
	const max = Math.max(0, length - rows);
	let next = Math.min(scroll, max);
	if (idx < next) next = idx;
	else if (idx >= next + rows) next = idx - rows + 1;
	return next;
}

/** A list to choose from, optionally filtered as you type. */
export class OptionModal<T> implements Component {
	private query = "";
	private idx: number;
	private scroll = 0;
	private shown: PickOption<T>[];
	private readonly haystacks: string[];

	constructor(
		private readonly options: PickOption<T>[],
		private readonly opts: PickOptions<T> | undefined,
		private readonly done: (value: T | null) => void,
	) {
		this.idx = Math.min(Math.max(0, opts?.defaultIndex ?? 0), Math.max(0, options.length - 1));
		this.shown = options;
		this.haystacks = options.map((o) => `${o.label}\n${o.description ?? ""}\n${o.searchText ?? ""}`.toLowerCase());
	}

	invalidate(): void {}

	private refilter(): void {
		const q = this.query.toLowerCase();
		const dynamic = this.opts?.search?.dynamicSearch;
		if (dynamic) this.shown = q.length === 0 ? this.options : dynamic(this.query);
		else if (q.length === 0) this.shown = this.options;
		else {
			const hits: Array<{ o: PickOption<T>; s: number; i: number }> = [];
			this.options.forEach((o, i) => {
				const s = score(this.haystacks[i] ?? "", q);
				if (s >= 0) hits.push({ o, s, i });
			});
			hits.sort((a, b) => b.s - a.s || a.i - b.i);
			this.shown = hits.map((h) => h.o);
		}
		this.idx = 0;
		this.scroll = 0;
	}

	handleInput(data: string): void {
		const count = this.shown.length;
		if (matchesKey(data, "up")) {
			if (count > 0) this.idx = (this.idx - 1 + count) % count;
		} else if (matchesKey(data, "down")) {
			if (count > 0) this.idx = (this.idx + 1) % count;
		} else if (matchesKey(data, "pageUp")) {
			this.idx = Math.max(0, this.idx - pickerRows());
		} else if (matchesKey(data, "pageDown")) {
			this.idx = Math.min(Math.max(0, count - 1), this.idx + pickerRows());
		} else if (matchesKey(data, "enter")) {
			const picked = this.shown[this.idx];
			if (picked && !picked.locked) this.done(picked.value);
		} else if (matchesKey(data, "escape")) {
			this.done(null);
		} else if (
			this.opts?.switchTo !== undefined &&
			(matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab"))
		) {
			this.done(this.opts.switchTo);
		} else if (this.opts?.search) {
			if (matchesKey(data, "backspace")) {
				this.query = this.query.slice(0, -1);
				this.refilter();
			} else {
				const typed = printable(data);
				if (typed) {
					this.query += typed;
					this.refilter();
				}
			}
		} else if (data === "q") {
			this.done(null);
		}
	}

	render(width: number): string[] {
		const colors = theme();
		const rows = pickerRows();
		this.scroll = keepVisible(this.idx, this.scroll, rows, this.shown.length);
		const body: string[] = [];
		if (this.opts?.error) body.push(paint(this.opts.error, { color: colors.error }), "");
		if (this.opts?.search) {
			body.push(
				paint("> ", { color: colors.muted }) + this.query + paint(" ", { color: colors.accent, bold: true }),
			);
			if (!this.query && this.opts.search.placeholder)
				body.push(paint(this.opts.search.placeholder, { color: colors.muted }));
		}
		if (this.shown.length === 0) body.push(paint("No matches", { color: colors.muted }));
		this.shown.slice(this.scroll, this.scroll + rows).forEach((o, vi) => {
			const i = this.scroll + vi;
			const selected = i === this.idx;
			const dull = o.muted || o.locked;
			body.push(
				choiceRow(selected ? "▸ " : "  ", o.label, width - 4, {
					selected,
					color: dull ? colors.muted : selected ? colors.accent : undefined,
					bold: !dull,
					hint: o.hint,
				}),
			);
			if (selected && o.description) body.push(`  ${paint(o.description, { color: colors.muted })}`);
		});
		const switchKeys = this.opts?.switchTo !== undefined ? ` – ←/→ ${this.opts.switchHint ?? "switch"}` : "";
		const hint = `${this.opts?.search ? "type to filter" : "up/down select"} – Enter confirm${switchKeys} – Esc cancel${
			this.shown.length > rows ? ` – ${this.idx + 1}/${this.shown.length}` : ""
		}`;
		return frame(this.opts?.title, body, hint, width);
	}
}

/** A line of text, with a default and a hint. */
export class TextModal implements Component, Focusable {
	private readonly input = new Input();
	private _focused = false;

	constructor(
		private readonly request: { label: string; defaultValue?: string; placeholder?: string; error?: string },
		done: (value: string | null) => void,
	) {
		this.input.setValue(request.defaultValue ?? "");
		this.input.onSubmit = (value) => done(value);
		this.input.onEscape = () => done(null);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const colors = theme();
		const body = [...this.input.render(Math.max(10, width - 4))];
		if (this.request.error) body.unshift(paint(this.request.error, { color: colors.error }), "");
		if (this.request.placeholder && this.input.getValue() === "")
			body.push(paint(this.request.placeholder, { color: colors.muted }));
		return frame(this.request.label, body, "Enter confirm – Esc cancel", width);
	}
}

/** A list where each row is on or off. */
export class MultiModal<T> implements Component {
	private idx: number;
	private scroll = 0;
	private readonly selected: Set<number>;

	constructor(
		private readonly options: PickOption<T>[],
		private readonly opts: PickOptions | undefined,
		initialSelected: Set<number>,
		private readonly done: (indices: number[] | null) => void,
	) {
		this.idx = Math.min(Math.max(0, opts?.defaultIndex ?? 0), Math.max(0, options.length - 1));
		this.selected = new Set(initialSelected);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const count = this.options.length;
		if (matchesKey(data, "up")) this.idx = (this.idx - 1 + count) % count;
		else if (matchesKey(data, "down")) this.idx = (this.idx + 1) % count;
		else if (data === " ") {
			if (this.options[this.idx]?.locked) return;
			if (this.selected.has(this.idx)) this.selected.delete(this.idx);
			else this.selected.add(this.idx);
		} else if (matchesKey(data, "enter")) this.done([...this.selected].sort((a, b) => a - b));
		else if (matchesKey(data, "escape")) this.done(null);
	}

	render(width: number): string[] {
		const colors = theme();
		const rows = pickerRows();
		this.scroll = keepVisible(this.idx, this.scroll, rows, this.options.length);
		const body: string[] = [];
		this.options.slice(this.scroll, this.scroll + rows).forEach((o, vi) => {
			const i = this.scroll + vi;
			const focused = i === this.idx;
			const dull = o.muted || o.locked;
			const box = o.locked ? "[-]" : this.selected.has(i) ? "[x]" : "[ ]";
			body.push(
				choiceRow(focused ? "▸ " : "  ", `${box} ${o.label}`, width - 4, {
					selected: focused,
					color: dull ? colors.muted : focused ? colors.accent : undefined,
					bold: !dull,
				}),
			);
			if (focused && o.description) body.push(`  ${paint(o.description, { color: colors.muted })}`);
		});
		return frame(this.opts?.title, body, "space toggle – Enter confirm – Esc cancel", width);
	}
}

/** The status bar's segments: which show, on which side, in what order. */
export class StatusBarModal implements Component {
	private items: Array<{ id: string; side: "left" | "right"; visible: boolean }>;
	private cursor = 0;

	constructor(
		private readonly segments: readonly StatusBarSegment[],
		initial: StatusBarConfig,
		private readonly done: (config: StatusBarConfig | null) => void,
		private readonly opts: { title?: string; sides?: boolean } = {},
	) {
		const visible = new Set(initial.visible);
		const order = initial.order.length > 0 ? initial.order : segments.map((s) => s.id);
		this.items = order.flatMap((id) => {
			const seg = segments.find((s) => s.id === id);
			return seg ? [{ id, side: initial.sides[id] ?? seg.side, visible: visible.has(id) }] : [];
		});
		for (const seg of segments) {
			if (!this.items.some((i) => i.id === seg.id))
				this.items.push({ id: seg.id, side: seg.side, visible: visible.has(seg.id) });
		}
	}

	invalidate(): void {}

	private move(direction: -1 | 1): void {
		const item = this.items[this.cursor];
		if (!item) return;
		for (let i = this.cursor + direction; i >= 0 && i < this.items.length; i += direction) {
			if (this.items[i]?.side === item.side) {
				const next = [...this.items];
				[next[this.cursor], next[i]] = [next[i]!, next[this.cursor]!];
				this.items = next;
				this.cursor = i;
				return;
			}
		}
	}

	private sideTo(side: "left" | "right"): void {
		const item = this.items[this.cursor];
		if (!item || item.side === side) return;
		const without = this.items.filter((_, i) => i !== this.cursor);
		let last = -1;
		without.forEach((it, i) => {
			if (it.side === side) last = i;
		});
		const at = last >= 0 ? last + 1 : side === "left" ? 0 : without.length;
		without.splice(at, 0, { ...item, side });
		this.items = without;
		this.cursor = at;
	}

	handleInput(data: string): void {
		const count = this.items.length;
		if (matchesKey(data, "up")) this.cursor = (this.cursor - 1 + count) % count;
		else if (matchesKey(data, "down")) this.cursor = (this.cursor + 1) % count;
		else if (data === " ") {
			const item = this.items[this.cursor];
			if (item) item.visible = !item.visible;
		} else if (this.opts.sides !== false && matchesKey(data, "left")) this.sideTo("left");
		else if (this.opts.sides !== false && matchesKey(data, "right")) this.sideTo("right");
		else if (data === "j" || data === "J") this.move(1);
		else if (data === "k" || data === "K") this.move(-1);
		else if (matchesKey(data, "enter")) {
			this.done({
				visible: this.items.filter((i) => i.visible).map((i) => i.id),
				order: this.items.map((i) => i.id),
				sides: Object.fromEntries(this.items.map((i) => [i.id, i.side])),
			});
		} else if (matchesKey(data, "escape") || data === "q") this.done(null);
	}

	render(width: number): string[] {
		const colors = theme();
		const labels = new Map(this.segments.map((s) => [s.id, s.label]));
		const body = this.items.map((item, i) => {
			const focused = i === this.cursor;
			return choiceRow(
				focused ? "▸ " : "  ",
				`${item.visible ? "[x]" : "[ ]"} ${labels.get(item.id) ?? item.id}${this.opts.sides === false ? "" : `  ${item.side}`}`,
				width - 4,
				{ selected: focused, color: focused ? colors.accent : undefined },
			);
		});
		const hint =
			this.opts.sides === false
				? "space show – j/k reorder – Enter save – Esc cancel"
				: "space show – ←/→ side – j/k reorder – Enter save – Esc cancel";
		return frame(this.opts.title ?? "Status bar segments", body, hint, width);
	}
}

type ItemRow = Exclude<SettingRow, { kind: "heading" }>;

/**
 * The settings screen. Toggles and choices change where they stand (Space, Enter,
 * ← →), and each row reads what it now holds; a row that is a flow of its own
 * (a model list, a prompt) closes the screen with the follow-up it needs, and the
 * caller runs it and brings the screen back.
 */
export class SettingsModal implements Component {
	private rows: SettingRow[];
	private cursor = 0;
	private scroll = 0;

	constructor(
		private readonly form: SettingsForm,
		private readonly done: (followUp: SettingFollowUp | null) => void,
		private readonly requestRender: () => void,
	) {
		this.rows = form.rows();
		this.cursor = this.items().findIndex(Boolean) === -1 ? 0 : 0;
	}

	invalidate(): void {}

	/** Positions in `rows` that can be selected (everything but headings). */
	private items(): number[] {
		return this.rows.flatMap((row, i) => (row.kind === "heading" ? [] : [i]));
	}

	private current(): ItemRow | undefined {
		const at = this.items()[this.cursor];
		const row = at === undefined ? undefined : this.rows[at];
		return row && row.kind !== "heading" ? row : undefined;
	}

	private apply(followUp: SettingFollowUp | undefined): void {
		this.rows = this.form.rows();
		this.cursor = Math.min(this.cursor, Math.max(0, this.items().length - 1));
		if (followUp) this.done(followUp);
		else this.requestRender();
	}

	private cycle(row: Extract<SettingRow, { kind: "choice" }>, step: 1 | -1): void {
		const at = Math.max(
			0,
			row.options.findIndex((o) => o.value === row.value),
		);
		const next = row.options[(at + step + row.options.length) % row.options.length];
		if (next) this.apply(row.set(next.value));
	}

	handleInput(data: string): void {
		const count = this.items().length;
		const row = this.current();
		if (matchesKey(data, "up")) this.cursor = (this.cursor - 1 + count) % count;
		else if (matchesKey(data, "down")) this.cursor = (this.cursor + 1) % count;
		else if (matchesKey(data, "pageUp")) this.cursor = Math.max(0, this.cursor - pickerRows());
		else if (matchesKey(data, "pageDown")) this.cursor = Math.min(count - 1, this.cursor + pickerRows());
		else if (matchesKey(data, "home")) this.cursor = 0;
		else if (matchesKey(data, "end")) this.cursor = count - 1;
		else if (matchesKey(data, "escape") || data === "q") this.done(null);
		else if (
			row?.kind === "toggle" &&
			(data === " " || matchesKey(data, "enter") || matchesKey(data, "left") || matchesKey(data, "right"))
		) {
			this.apply(row.set(!row.value));
			return;
		} else if (row?.kind === "choice") {
			if (matchesKey(data, "left")) this.cycle(row, -1);
			else if (matchesKey(data, "right") || data === " ") this.cycle(row, 1);
			else if (matchesKey(data, "enter")) {
				if (row.choose) this.done(row.choose);
				else this.cycle(row, 1);
			}
			return;
		} else if (row?.kind === "open" && (matchesKey(data, "enter") || matchesKey(data, "right") || data === " ")) {
			this.done(row.open);
			return;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const colors = theme();
		const inner = Math.max(20, width - 4);
		const selectable = this.items();
		const selectedAt = selectable[this.cursor];
		const lines: Array<{ text: string; at?: number }> = [];
		this.rows.forEach((row, i) => {
			if (row.kind === "heading") {
				if (lines.length > 0) lines.push({ text: "" });
				lines.push({ text: paint(row.label.toUpperCase(), { bold: true }) });
				return;
			}
			const selected = i === selectedAt;
			lines.push({ text: settingRow(row, selected, inner), at: i });
		});
		// Keep the chosen row in view; headings and blanks scroll with it.
		// The overlay may take 85% of the screen; the box itself, the blank row, the description and the footer take five.
		const rows = Math.max(3, Math.floor((process.stdout.rows || 24) * 0.85) - 5);
		const selectedLine = lines.findIndex((l) => l.at === selectedAt);
		this.scroll = keepVisible(Math.max(0, selectedLine), this.scroll, rows, lines.length);
		const body = lines.slice(this.scroll, this.scroll + rows).map((l) => l.text);
		const description = this.current()?.description;
		body.push("", description ? paint(description, { color: colors.muted }) : " ");
		return frame(this.form.title, body, "↑↓ move * Space/Enter change * ←/→ cycle * Esc close", width);
	}
}

/** One row: the name on the left, what it is set to on the right. */
function settingRow(row: ItemRow, selected: boolean, inner: number): string {
	const colors = theme();
	const bg = selected ? surfaceHover() : undefined;
	let value: string;
	if (row.kind === "toggle") {
		value = row.value
			? paint("● on", { color: colors.success, bold: true, bg })
			: paint("○ off", { color: colors.muted, bg });
	} else if (row.kind === "choice") {
		value = paint(`‹ ${row.value} ›`, { color: colors.accent, bg });
	} else {
		// A long value (a provider URL) gives way, so the name beside it stays whole.
		value = paint(`${truncateToWidth(row.value, Math.max(12, Math.floor(inner / 2)), "…")} ›`, {
			color: colors.muted,
			bg,
		});
	}
	const left = paint(selected ? "▸ " : "  ", { color: selected ? colors.accent : colors.muted, bg });
	const room = inner - visibleWidth(left) - visibleWidth(value) - 2;
	const label = truncateToWidth(row.label, Math.max(4, room), "…");
	const name = paint(label, { color: selected ? colors.accent : undefined, bold: selected, bg });
	const gap = paint(" ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(name) - visibleWidth(value))), {
		bg,
	});
	const text = left + name + gap + value;
	return bg ? band(text, inner, bg) : text;
}

/** Text that keeps changing while it is open: a running subagent's session. */
export class ViewModal implements Component {
	private snapshot: { text: string; running: boolean };
	private fromBottom = 0;
	private stopped = false;

	constructor(
		private readonly view: LiveView,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {
		this.snapshot = view.read();
	}

	/** Re-reads the source; called on a timer while the modal is open. */
	refresh(): void {
		this.snapshot = this.view.read();
		this.requestRender();
	}

	invalidate(): void {}

	private viewportRows(): number {
		return Math.max(6, (process.stdout.rows || 24) - 10);
	}

	handleInput(data: string): void {
		const rows = this.viewportRows();
		const total = this.snapshot.text.split("\n").length;
		const maxBack = Math.max(0, total - rows);
		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "q") this.done();
		else if (matchesKey(data, "up")) this.fromBottom = Math.min(maxBack, this.fromBottom + 1);
		else if (matchesKey(data, "down")) this.fromBottom = Math.max(0, this.fromBottom - 1);
		else if (matchesKey(data, "pageUp")) this.fromBottom = Math.min(maxBack, this.fromBottom + rows);
		else if (matchesKey(data, "pageDown")) this.fromBottom = Math.max(0, this.fromBottom - rows);
		else if (data === "s" && this.snapshot.running && this.view.stop && !this.stopped) {
			this.stopped = true;
			void Promise.resolve(this.view.stop()).catch(() => {});
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const rows = this.viewportRows();
		const lines = this.snapshot.text.split("\n");
		const back = Math.min(this.fromBottom, Math.max(0, lines.length - rows));
		const end = Math.max(rows, lines.length - back);
		const window = lines.slice(Math.max(0, end - rows), end);
		const state = this.snapshot.running ? (this.stopped ? "* stopping…" : "* running") : "* finished";
		const canStop = this.snapshot.running && this.view.stop !== undefined && !this.stopped;
		const footer = `${back > 0 ? `${back} lines below * ` : ""}esc back * ↑↓ PgUp/PgDn scroll${canStop ? " * s stop it" : ""}`;
		return frame(
			`${this.view.title} ${state}`,
			window.map((l) => l || " "),
			footer,
			width,
		);
	}
}

/** A one-line activity overlay (connection checks and the like). */
export class StatusModal implements Component {
	private frameIndex = 0;

	constructor(private readonly label: string) {}

	tick(): void {
		this.frameIndex++;
	}

	invalidate(): void {}

	handleInput(): void {}

	render(width: number): string[] {
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const spin = frames[this.frameIndex % frames.length] ?? "";
		return frame(undefined, [`${paint(spin, { color: theme().accent })} ${this.label}`], "", width);
	}
}

/** Shows the bridge's current request as an overlay, and takes it down when it is answered. */
export class ModalHost {
	private current: ModalRequest | null = null;
	private handle: OverlayHandle | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly tui: TUI) {}

	sync(request: ModalRequest | null): void {
		if (request === this.current) return;
		this.close();
		this.current = request;
		if (!request) return;
		const build = this.build(request);
		if (!build) return;
		const transient = request.kind === "status";
		this.handle = this.tui.showOverlay(transient ? build.component : new Sheet(build.component), {
			anchor: "bottom-center",
			width: transient ? "90%" : "100%",
			maxHeight: "85%",
			margin: { bottom: 3 },
			nonCapturing: transient,
		});
		if (build.every) {
			this.timer = setInterval(() => {
				build.every?.();
				this.tui.requestRender();
			}, build.everyMs ?? POLL_MS);
		}
		this.tui.requestRender();
	}

	private close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.handle?.hide();
		this.handle = undefined;
	}

	dispose(): void {
		this.close();
		this.current = null;
	}

	private build(request: ModalRequest): { component: Component; every?: () => void; everyMs?: number } | undefined {
		switch (request.kind) {
			case "option":
				return { component: new OptionModal(request.options, request.opts, (value) => request.resolve(value)) };
			case "text":
				return { component: new TextModal(request, (value) => request.resolve(value)) };
			case "multi":
				return {
					component: new MultiModal(request.options, request.opts, request.initialSelected, (indices) =>
						request.resolve(indices),
					),
				};
			case "statusbar":
				return {
					component: new StatusBarModal(
						request.segments,
						request.initialConfig,
						(config) => request.resolve(config),
						request.opts,
					),
				};
			case "settings":
				return {
					component: new SettingsModal(request.form, request.resolve, () => this.tui.requestRender()),
				};
			case "view": {
				const modal = new ViewModal(request.view, request.resolve, () => this.tui.requestRender());
				return { component: modal, every: () => modal.refresh() };
			}
			case "status": {
				const modal = new StatusModal(request.label);
				return { component: modal, every: () => modal.tick(), everyMs: 120 };
			}
			default:
				return undefined;
		}
	}
}
