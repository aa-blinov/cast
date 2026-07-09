import { describe, expect, it } from "vitest";
import { reconfigureConnection, selectPermissionMode } from "../src/pickers/domain.ts";
import type { Pickers } from "../src/pickers/types.ts";

/** Fake pickers whose promptText hands back queued answers in call order. */
function promptPickers(answers: (string | null)[]): Pickers {
	let i = 0;
	return {
		pickOption: async () => null,
		promptText: async () => answers[i++] ?? null,
		log: () => {},
	} as unknown as Pickers;
}

const current = { baseURL: "https://old.example/v1", apiKey: "sk-aaaaaaaat90h" };

describe("reconfigureConnection", () => {
	it("returns the new URL and key when both are entered", async () => {
		const creds = await reconfigureConnection(promptPickers(["https://new.example/v1", "sk-new"]), current, "reason");
		expect(creds).toEqual({ baseURL: "https://new.example/v1", apiKey: "sk-new" });
	});

	it("keeps the current URL when the URL prompt is left blank", async () => {
		const creds = await reconfigureConnection(promptPickers(["   ", "sk-new"]), current, "reason");
		expect(creds).toEqual({ baseURL: current.baseURL, apiKey: "sk-new" });
	});

	it("cancels (null) when the URL prompt is escaped", async () => {
		expect(await reconfigureConnection(promptPickers([null]), current, "reason")).toBeNull();
	});

	it("cancels (null) when the key prompt is escaped", async () => {
		expect(
			await reconfigureConnection(promptPickers(["https://new.example/v1", null]), current, "reason"),
		).toBeNull();
	});

	it("cancels (null) on a blank key — the old one is known-bad, so no keep-current", async () => {
		expect(
			await reconfigureConnection(promptPickers(["https://new.example/v1", "  "]), current, "reason"),
		).toBeNull();
	});
});

describe("selectPermissionMode", () => {
	function pickPickers(value: unknown): Pickers {
		return { pickOption: async () => value, promptText: async () => null, log: () => {} } as unknown as Pickers;
	}

	it("returns the picked mode", async () => {
		expect(await selectPermissionMode(pickPickers("bypass"), "default")).toBe("bypass");
	});

	it("leaves the current mode unchanged when cancelled", async () => {
		expect(await selectPermissionMode(pickPickers(null), "default")).toBe("default");
	});
});
