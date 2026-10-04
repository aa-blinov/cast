import { describe, expect, it } from "vitest";
import type { Pickers } from "../src/pickers/types.ts";
import { deriveFormFields, multiError, parseFieldInput, reviewLines, runMcpForm } from "../src/ui/mcp-form.ts";

const schema = {
	type: "object" as const,
	properties: {
		name: { type: "string" as const, title: "Name", minLength: 2 },
		age: { type: "integer" as const, minimum: 18, maximum: 99 },
		email: { type: "string" as const, format: "email" as const },
		agree: { type: "boolean" as const, default: true },
		color: { type: "string" as const, enum: ["red", "blue"], enumNames: ["Red", "Blue"] },
		tags: {
			type: "array" as const,
			items: {
				anyOf: [
					{ const: "a", title: "Alpha" },
					{ const: "b", title: "Beta" },
				],
			},
			minItems: 1,
		},
	},
	required: ["name", "agree"],
};

describe("deriveFormFields", () => {
	it("types each property and marks the required ones", () => {
		const fields = deriveFormFields(schema);
		expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
			["name", "text", true],
			["age", "number", false],
			["email", "text", false],
			["agree", "boolean", true],
			["color", "choice", false],
			["tags", "multi", false],
		]);
		expect(fields.find((f) => f.key === "color")).toMatchObject({
			options: [
				{ value: "red", label: "Red" },
				{ value: "blue", label: "Blue" },
			],
		});
		expect(fields.find((f) => f.key === "tags")).toMatchObject({
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			minItems: 1,
		});
		expect(fields.find((f) => f.key === "agree")?.defaultValue).toBe(true);
	});
});

describe("parseFieldInput", () => {
	const [name, age, email] = deriveFormFields(schema);
	it("checks length, range, whole numbers and formats", () => {
		expect(parseFieldInput(name!, " ")).toEqual({ ok: false, error: "Required" });
		expect(parseFieldInput(name!, "A")).toEqual({ ok: false, error: "At least 2 characters" });
		expect(parseFieldInput(name!, " Ada ")).toEqual({ ok: true, value: "Ada" });
		expect(parseFieldInput(age!, "")).toEqual({ ok: true, value: undefined });
		expect(parseFieldInput(age!, "x")).toEqual({ ok: false, error: "Not a number" });
		expect(parseFieldInput(age!, "20.5")).toEqual({ ok: false, error: "Must be a whole number" });
		expect(parseFieldInput(age!, "17")).toEqual({ ok: false, error: "At least 18" });
		expect(parseFieldInput(age!, "100")).toEqual({ ok: false, error: "At most 99" });
		expect(parseFieldInput(age!, "42")).toEqual({ ok: true, value: 42 });
		expect(parseFieldInput(email!, "nope")).toEqual({ ok: false, error: "Not an email address" });
		expect(parseFieldInput(email!, "a@b.co")).toEqual({ ok: true, value: "a@b.co" });
	});

	it("checks a multi choice's size", () => {
		const tags = deriveFormFields(schema).find((f) => f.key === "tags")!;
		expect(multiError(tags, [])).toBe("Choose at least 1");
		expect(multiError(tags, ["a"])).toBeUndefined();
	});
});

describe("reviewLines", () => {
	it("shows what will be sent, with choices by their label", () => {
		const fields = deriveFormFields(schema);
		expect(reviewLines(fields, { name: "Ada", agree: false, color: "red", tags: ["a", "b"] })).toEqual([
			"Name: Ada",
			"age: (left out)",
			"email: (left out)",
			"agree: no",
			"color: Red",
			"tags: a, b",
		]);
	});
});

/** Pickers that answer from a script, in the order they are asked. */
function scripted(answers: unknown[]) {
	const asked: Array<{ kind: string; label?: string; error?: string; title?: string; detail?: string }> = [];
	const next = () => (answers.length > 0 ? answers.shift() : null);
	const pickers = {
		log: () => {},
		promptText: async (label: string, _d?: string, _p?: string, error?: string) => {
			asked.push({ kind: "text", label, error });
			return next();
		},
		pickOption: async (_o: unknown, opts?: { title?: string; detail?: string }) => {
			asked.push({ kind: "option", title: opts?.title, detail: opts?.detail });
			return next();
		},
		pickMulti: async (_o: unknown, opts?: { title?: string; error?: string }) => {
			asked.push({ kind: "multi", title: opts?.title, error: opts?.error });
			return next();
		},
	} as unknown as Pickers;
	return { pickers, asked };
}

const signal = new AbortController().signal;
const params = { message: "Tell me", requestedSchema: schema };

describe("runMcpForm", () => {
	it("asks every field, asks again after a bad answer, and sends the values after a last look", async () => {
		const { pickers, asked } = scripted(["A", "Ada", "", "", "true", "blue", ["a"], "accept"]);
		const result = await runMcpForm(pickers, "crm", params, signal);
		expect(result).toEqual({ action: "accept", content: { name: "Ada", agree: true, color: "blue", tags: ["a"] } });
		expect(asked[1]).toMatchObject({ kind: "text", error: "At least 2 characters" });
		expect(asked.at(-1)?.detail).toContain("Name: Ada");
		expect(asked[0]!.label).toBe("crm: Name *");
	});

	it("cancels on Esc anywhere and declines when the person declines", async () => {
		expect(await runMcpForm(scripted([null]).pickers, "crm", params, signal)).toEqual({ action: "cancel" });
		expect(
			await runMcpForm(scripted(["Ada", "", "", "true", "red", ["a"], "decline"]).pickers, "crm", params, signal),
		).toEqual({ action: "decline" });
	});

	it("declines a server that asks for a web visit instead of a form", async () => {
		const url = { mode: "url", message: "Sign in", url: "https://x.test", elicitationId: "1" } as const;
		expect(await runMcpForm(scripted([]).pickers, "crm", url, signal)).toEqual({ action: "decline" });
	});

	it("stops asking once the request is settled elsewhere", async () => {
		const controller = new AbortController();
		const { pickers } = scripted([]);
		controller.abort();
		expect(await runMcpForm(pickers, "crm", params, controller.signal)).toEqual({ action: "cancel" });
	});
});
