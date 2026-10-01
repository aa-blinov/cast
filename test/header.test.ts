import { describe, expect, it } from "vitest";
import { defaultHeaderConfig, headerSegments, headerTexts } from "../src/ui/header.ts";

const ctx = { persona: "Senior Developer", model: "m1", version: "1.2.3", folder: "~/proj" };

describe("header", () => {
	it("shows persona, model, version and folder by default, the folder last so it goes first on a short row", () => {
		expect(headerTexts(defaultHeaderConfig(), ctx)).toEqual(["Senior Developer", "m1", "v1.2.3", "~/proj"]);
	});

	it("follows the configured order and leaves out what is switched off", () => {
		const config = { visible: ["version", "model"], order: ["version", "folder", "model", "persona"] };
		expect(headerTexts(config, ctx)).toEqual(["v1.2.3", "m1"]);
	});

	it("puts a part the saved config has never heard of after the known ones, if it is on", () => {
		const config = { visible: ["persona", "folder"], order: ["persona"] };
		expect(headerTexts(config, ctx)).toEqual(["Senior Developer", "~/proj"]);
	});

	it("offers the same parts to the shared list editor, all on one side", () => {
		const segments = headerSegments();
		expect(segments.map((s) => s.id)).toEqual(["persona", "model", "version", "folder"]);
		expect(new Set(segments.map((s) => s.side))).toEqual(new Set(["left"]));
	});
});
