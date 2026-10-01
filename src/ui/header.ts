import type { HeaderConfig } from "../core/settings.ts";
import type { StatusBarSegment } from "./statusbar.ts";

// The row at the top of the screen, `CAST(1) * persona * model * …`: which parts it
// carries and in what order. It is the status bar's sibling, edited by the same list.

export interface HeaderContext {
	persona: string;
	model: string;
	version: string;
	/** The working folder, with the home directory as `~`. */
	folder: string;
}

interface HeaderPart extends Pick<StatusBarSegment, "id" | "label" | "defaultOn"> {
	text: (ctx: HeaderContext) => string;
}

// Order is the default order: what goes first is kept longest when the row is short,
// so the folder, the longest and least needed part, is last.
const PARTS: HeaderPart[] = [
	{ id: "persona", label: "Persona", defaultOn: true, text: (ctx) => ctx.persona },
	{ id: "model", label: "Model", defaultOn: true, text: (ctx) => ctx.model },
	{ id: "version", label: "Version", defaultOn: true, text: (ctx) => `v${ctx.version}` },
	{ id: "folder", label: "Folder", defaultOn: true, text: (ctx) => ctx.folder },
];

export function defaultHeaderConfig(): HeaderConfig {
	return { visible: PARTS.filter((p) => p.defaultOn).map((p) => p.id), order: PARTS.map((p) => p.id) };
}

/** The parts as list rows for the shared segment editor (they all sit on one side). */
export function headerSegments(): StatusBarSegment[] {
	return PARTS.map((p) => ({
		id: p.id,
		label: p.label,
		defaultOn: p.defaultOn,
		side: "left",
		formatValue: () => null,
	}));
}

/** The text of each part that is switched on, in the configured order; a part the config does not know yet comes last. */
export function headerTexts(config: HeaderConfig, ctx: HeaderContext): string[] {
	const visible = new Set(config.visible);
	const known = config.order.flatMap((id) => PARTS.filter((p) => p.id === id));
	const ordered = [...known, ...PARTS.filter((p) => !config.order.includes(p.id))];
	return ordered.filter((p) => visible.has(p.id)).map((p) => p.text(ctx));
}
