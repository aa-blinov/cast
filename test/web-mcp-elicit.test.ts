import { describe, expect, it } from "vitest";
import { elicitContent, elicitErrors, elicitFields, elicitInitialValues } from "../src/server/public/mcp-elicit.js";

const schema = {
	type: "object",
	required: ["name", "age"],
	properties: {
		name: { type: "string", title: "Name", minLength: 2, maxLength: 5 },
		email: { type: "string", format: "email" },
		age: { type: "integer", minimum: 18, maximum: 99 },
		ratio: { type: "number", default: 0.5 },
		agree: { type: "boolean", default: true },
		size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
		color: {
			type: "string",
			oneOf: [
				{ const: "r", title: "Red" },
				{ const: "g", title: "Green" },
			],
		},
		tags: { type: "array", items: { enum: ["a", "b", "c"] }, minItems: 1 },
		weird: { type: "object" },
	},
};

describe("elicitFields", () => {
	it("turns each property into a field and skips what a form cannot draw", () => {
		const fields = elicitFields(schema);
		expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
			["name", "text", true],
			["email", "text", false],
			["age", "integer", true],
			["ratio", "number", false],
			["agree", "boolean", false],
			["size", "select", false],
			["color", "select", false],
			["tags", "multi", false],
		]);
		expect(fields[0]).toMatchObject({ label: "Name", minLength: 2, maxLength: 5 });
		expect(fields[5]!.options).toEqual([
			{ value: "s", label: "Small" },
			{ value: "m", label: "Medium" },
		]);
		expect(fields[6]!.options).toEqual([
			{ value: "r", label: "Red" },
			{ value: "g", label: "Green" },
		]);
	});

	it("starts from the defaults", () => {
		expect(elicitInitialValues(elicitFields(schema))).toMatchObject({
			name: "",
			ratio: "0.5",
			agree: true,
			tags: [],
		});
	});
});

describe("elicitErrors", () => {
	const fields = elicitFields(schema);
	const valid = { ...elicitInitialValues(fields), name: "Ada", age: "30", tags: ["a"] };

	it("accepts a filled form", () => {
		expect(elicitErrors(fields, valid)).toEqual({});
	});

	it("names what is missing or out of range", () => {
		expect(elicitErrors(fields, { ...valid, name: "A", age: "17", email: "nope", ratio: "x" })).toEqual({
			name: "At least 2 characters",
			age: "At least 18",
			email: "Enter an email address",
			ratio: "Enter a number",
		});
		expect(elicitErrors(fields, { ...valid, name: "", age: "" })).toEqual({ name: "Required", age: "Required" });
		expect(elicitErrors(fields, { ...valid, age: "100" }).age).toBe("At most 99");
		expect(elicitErrors(fields, { ...valid, age: "20.5" }).age).toBe("Enter a whole number");
		expect(elicitErrors(fields, { ...valid, name: "Abcdef" }).name).toBe("At most 5 characters");
	});
});

describe("elicitContent", () => {
	it("types the values and leaves out an unfilled optional field", () => {
		const fields = elicitFields(schema);
		const values = {
			...elicitInitialValues(fields),
			name: "Ada",
			age: "30",
			ratio: "",
			size: "m",
			tags: ["a", "c"],
			agree: false,
		};
		expect(elicitContent(fields, values)).toEqual({
			name: "Ada",
			age: 30,
			agree: false,
			size: "m",
			tags: ["a", "c"],
		});
	});

	it("sends a date-time as an ISO instant", () => {
		const fields = elicitFields({ type: "object", properties: { at: { type: "string", format: "date-time" } } });
		expect(elicitContent(fields, { at: "2026-10-04T12:00" }).at).toBe(new Date("2026-10-04T12:00").toISOString());
	});
});
