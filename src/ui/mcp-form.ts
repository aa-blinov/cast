import type { ElicitRequest, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pickers, PickOption } from "../pickers/types.ts";

export type FormValue = string | number | boolean | string[];

interface FormOption {
	value: string;
	label: string;
}

export type FormField = {
	key: string;
	title: string;
	description?: string;
	required: boolean;
	defaultValue?: FormValue;
} & (
	| { kind: "text"; format?: string; minLength?: number; maxLength?: number }
	| { kind: "number"; integer: boolean; min?: number; max?: number }
	| { kind: "boolean" }
	| { kind: "choice"; options: FormOption[] }
	| { kind: "multi"; options: FormOption[]; minItems?: number; maxItems?: number }
);

type Raw = Record<string, unknown>;

const asRaw = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The choices a schema offers: `enum` (with the older `enumNames`) or a `oneOf`/`anyOf` of `{const, title}`. */
function optionsOf(schema: Raw): FormOption[] | undefined {
	const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
	if (titled) {
		return titled.flatMap((entry) => {
			const { const: value, title } = asRaw(entry);
			return typeof value === "string" ? [{ value, label: str(title) ?? value }] : [];
		});
	}
	if (Array.isArray(schema.enum)) {
		const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
		return schema.enum.flatMap((value, i) =>
			typeof value === "string" ? [{ value, label: str(names[i]) ?? value }] : [],
		);
	}
	return undefined;
}

/** The fields of a server's form, in the order it listed them. A property of a kind a form cannot ask for is typed as text. */
export function deriveFormFields(schema: ElicitRequestFormParams["requestedSchema"]): FormField[] {
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties ?? {}).map(([key, property]): FormField => {
		const raw = asRaw(property);
		const base = {
			key,
			title: str(raw.title) ?? key,
			description: str(raw.description),
			required: required.has(key),
			defaultValue: raw.default as FormValue | undefined,
		};
		if (raw.type === "boolean") return { ...base, kind: "boolean" };
		if (raw.type === "number" || raw.type === "integer") {
			return {
				...base,
				kind: "number",
				integer: raw.type === "integer",
				min: num(raw.minimum),
				max: num(raw.maximum),
			};
		}
		if (raw.type === "array") {
			const options = optionsOf(asRaw(raw.items)) ?? [];
			return { ...base, kind: "multi", options, minItems: num(raw.minItems), maxItems: num(raw.maxItems) };
		}
		const options = optionsOf(raw);
		if (options) return { ...base, kind: "choice", options };
		return {
			...base,
			kind: "text",
			format: str(raw.format),
			minLength: num(raw.minLength),
			maxLength: num(raw.maxLength),
		};
	});
}

export type Parsed = { ok: true; value: FormValue | undefined } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function textFormatError(format: string | undefined, value: string): string | undefined {
	if (format === "email" && !EMAIL_RE.test(value)) return "Not an email address";
	if (format === "uri" && !URL.canParse(value)) return "Not a URL";
	if (format === "date" && (!DATE_RE.test(value) || Number.isNaN(Date.parse(value)))) return "Use YYYY-MM-DD";
	if (format === "date-time" && Number.isNaN(Date.parse(value)))
		return "Use a date and time, like 2026-01-31T09:30:00Z";
	return undefined;
}

/** What was typed for a text or number field: its value, nothing (an optional field left empty), or why it is wrong. */
export function parseFieldInput(field: FormField, raw: string): Parsed {
	const text = raw.trim();
	if (text === "") return field.required ? { ok: false, error: "Required" } : { ok: true, value: undefined };
	if (field.kind === "number") {
		const value = Number(text);
		if (!Number.isFinite(value)) return { ok: false, error: "Not a number" };
		if (field.integer && !Number.isInteger(value)) return { ok: false, error: "Must be a whole number" };
		if (field.min !== undefined && value < field.min) return { ok: false, error: `At least ${field.min}` };
		if (field.max !== undefined && value > field.max) return { ok: false, error: `At most ${field.max}` };
		return { ok: true, value };
	}
	if (field.kind !== "text") return { ok: false, error: "Not a typed field" };
	if (field.minLength !== undefined && text.length < field.minLength)
		return { ok: false, error: `At least ${field.minLength} characters` };
	if (field.maxLength !== undefined && text.length > field.maxLength)
		return { ok: false, error: `At most ${field.maxLength} characters` };
	const bad = textFormatError(field.format, text);
	return bad ? { ok: false, error: bad } : { ok: true, value: text };
}

/** Whether a set of chosen options fits the field, or why not. */
export function multiError(field: FormField, chosen: string[]): string | undefined {
	if (field.kind !== "multi") return undefined;
	if (field.required && chosen.length === 0) return "Choose at least one";
	if (field.minItems !== undefined && chosen.length < field.minItems) return `Choose at least ${field.minItems}`;
	if (field.maxItems !== undefined && chosen.length > field.maxItems) return `Choose at most ${field.maxItems}`;
	return undefined;
}

const shown = (field: FormField, value: FormValue): string => {
	if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
	if (field.kind === "choice") return field.options.find((o) => o.value === value)?.label ?? String(value);
	return typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
};

/** The answers as lines for the final look before they are sent. */
export function reviewLines(fields: FormField[], values: Record<string, FormValue>): string[] {
	return fields.map((f) => {
		const value = values[f.key];
		return `${f.title}: ${value === undefined ? "(left out)" : shown(f, value)}`;
	});
}

const LEAVE_OUT = "\u0000leave-out";

function labelOf(server: string, field: FormField): string {
	return `${server}: ${field.title}${field.required ? " *" : ""}${field.description ? ` (${field.description})` : ""}`;
}

/**
 * Asks the person for a server's form, one field at a time on the terminal's own pickers, then a last look. Esc anywhere
 * cancels; "Decline" refuses the form. A server asking for a web visit rather than a form is declined.
 */
export async function runMcpForm(
	pickers: Pickers,
	server: string,
	params: ElicitRequest["params"],
	signal: AbortSignal,
): Promise<ElicitResult> {
	if (params.mode === "url") return { action: "decline" };
	const fields = deriveFormFields(params.requestedSchema);
	pickers.log(`MCP ${server} asks: ${params.message}`);
	const values: Record<string, FormValue> = {};
	const cancelled = (): ElicitResult => ({ action: "cancel" });

	for (const field of fields) {
		let error: string | undefined;
		for (;;) {
			if (signal.aborted) return cancelled();
			const label = labelOf(server, field);
			if (field.kind === "text" || field.kind === "number") {
				const initial = field.defaultValue === undefined ? undefined : String(field.defaultValue);
				// biome-ignore lint/performance/noAwaitInLoops: one question at a time, each waits for the person
				const raw = await pickers.promptText(label, initial, undefined, error, { signal });
				if (raw === null || signal.aborted) return cancelled();
				const parsed = parseFieldInput(field, raw);
				if (!parsed.ok) {
					error = parsed.error;
					continue;
				}
				if (parsed.value !== undefined) values[field.key] = parsed.value;
				break;
			}
			if (field.kind === "multi") {
				const options: PickOption<string>[] = field.options.map((o) => ({ value: o.value, label: o.label }));
				const initial = Array.isArray(field.defaultValue) ? field.defaultValue : [];
				const chosen = await pickers.pickMulti(options, { title: label, error, initialSelected: initial, signal });
				if (chosen === null || signal.aborted) return cancelled();
				error = multiError(field, chosen);
				if (error) continue;
				if (chosen.length > 0) values[field.key] = chosen;
				break;
			}
			const options: PickOption<string>[] =
				field.kind === "boolean"
					? [
							{ value: "true", label: "Yes", key: "y" },
							{ value: "false", label: "No", key: "n" },
						]
					: field.options.map((o) => ({ value: o.value, label: o.label }));
			if (!field.required) options.push({ value: LEAVE_OUT, label: "(leave out)" });
			const defaultIndex = Math.max(
				0,
				options.findIndex((o) => o.value === String(field.defaultValue)),
			);
			const picked = await pickers.pickOption(options, { title: label, defaultIndex, signal });
			if (picked === null || signal.aborted) return cancelled();
			if (picked !== LEAVE_OUT) values[field.key] = field.kind === "boolean" ? picked === "true" : picked;
			break;
		}
	}

	const review = await pickers.pickOption(
		[
			{ value: "accept", label: "Send (y)", key: "y" },
			{ value: "decline", label: "Decline (n)", key: "n" },
		],
		{ title: `Send this to ${server}?`, detail: [params.message, ...reviewLines(fields, values)].join("\n"), signal },
	);
	if (review === null || signal.aborted) return cancelled();
	return review === "accept" ? { action: "accept", content: values } : { action: "decline" };
}
