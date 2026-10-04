// An MCP server's form (elicitation): its JSON schema turned into fields, checked and read back as the object the
// server asked for. Pure, so the card only has to draw it.

const choices = (list) =>
	list.map((entry) => (typeof entry === "object" ? { value: String(entry.const), label: entry.title ?? String(entry.const) } : { value: String(entry), label: String(entry) }));

function optionsOf(schema) {
	if (Array.isArray(schema.oneOf)) return choices(schema.oneOf);
	if (Array.isArray(schema.enum)) {
		const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
		return schema.enum.map((value, index) => ({ value: String(value), label: names[index] ?? String(value) }));
	}
	return null;
}

/** One field per property of the schema; a property of a kind a form cannot draw is skipped. */
export function elicitFields(schema) {
	const required = new Set(schema?.required ?? []);
	const fields = [];
	for (const [name, spec] of Object.entries(schema?.properties ?? {})) {
		const base = { name, label: spec.title || name, description: spec.description, required: required.has(name), default: spec.default };
		if (spec.type === "boolean") fields.push({ ...base, kind: "boolean" });
		else if (spec.type === "array") {
			const options = optionsOf(spec.items ?? {}) ?? (Array.isArray(spec.items?.anyOf) ? choices(spec.items.anyOf) : null);
			if (options) fields.push({ ...base, kind: "multi", options, minItems: spec.minItems, maxItems: spec.maxItems });
		} else if (spec.type === "number" || spec.type === "integer") {
			fields.push({ ...base, kind: spec.type, min: spec.minimum, max: spec.maximum });
		} else if (spec.type === "string") {
			const options = optionsOf(spec);
			if (options) fields.push({ ...base, kind: "select", options });
			else fields.push({ ...base, kind: "text", format: spec.format, minLength: spec.minLength, maxLength: spec.maxLength });
		}
	}
	return fields;
}

export function elicitInitialValues(fields) {
	const values = {};
	for (const f of fields) {
		if (f.kind === "boolean") values[f.name] = f.default === true;
		else if (f.kind === "multi") values[f.name] = Array.isArray(f.default) ? f.default.map(String) : [];
		else values[f.name] = f.default === undefined ? "" : String(f.default);
	}
	return values;
}

const blank = (f, v) => (f.kind === "multi" ? v.length === 0 : f.kind === "boolean" ? false : String(v).trim() === "");

/** The message for each field that is not acceptable yet; empty when the form can be sent. */
export function elicitErrors(fields, values) {
	const errors = {};
	for (const f of fields) {
		const v = values[f.name];
		if (blank(f, v)) {
			if (f.required && f.kind !== "boolean") errors[f.name] = "Required";
			continue;
		}
		if (f.kind === "number" || f.kind === "integer") {
			const n = Number(v);
			if (!Number.isFinite(n)) errors[f.name] = "Enter a number";
			else if (f.kind === "integer" && !Number.isInteger(n)) errors[f.name] = "Enter a whole number";
			else if (f.min !== undefined && n < f.min) errors[f.name] = `At least ${f.min}`;
			else if (f.max !== undefined && n > f.max) errors[f.name] = `At most ${f.max}`;
		} else if (f.kind === "text") {
			if (f.minLength !== undefined && v.length < f.minLength) errors[f.name] = `At least ${f.minLength} characters`;
			else if (f.maxLength !== undefined && v.length > f.maxLength) errors[f.name] = `At most ${f.maxLength} characters`;
			else if (f.format === "email" && !v.includes("@")) errors[f.name] = "Enter an email address";
			else if (f.format === "uri" && !URL.canParse(v)) errors[f.name] = "Enter a full URL";
		} else if (f.kind === "multi") {
			if (f.minItems !== undefined && v.length < f.minItems) errors[f.name] = `Pick at least ${f.minItems}`;
			else if (f.maxItems !== undefined && v.length > f.maxItems) errors[f.name] = `Pick at most ${f.maxItems}`;
		}
	}
	return errors;
}

/** What goes back to the server: typed values, an unfilled optional field left out. */
export function elicitContent(fields, values) {
	const content = {};
	for (const f of fields) {
		const v = values[f.name];
		if (f.kind === "boolean") content[f.name] = v === true;
		else if (blank(f, v)) continue;
		else if (f.kind === "number" || f.kind === "integer") content[f.name] = Number(v);
		else if (f.kind === "text" && f.format === "date-time") content[f.name] = new Date(v).toISOString();
		else content[f.name] = v;
	}
	return content;
}
