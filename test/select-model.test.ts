import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { fetchModels, runOnboardingCheck } from "../src/core/config.ts";
import { selectModel } from "../src/pickers/domain.ts";
import type { Pickers, PickOption } from "../src/pickers/types.ts";

// selectModel makes two real network round-trips (fetchModels for the list,
// runOnboardingCheck to validate a pick). Stub both so these tests exercise
// only the selection/validation control flow.
vi.mock("../src/core/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/config.ts")>();
	return { ...actual, fetchModels: vi.fn(), runOnboardingCheck: vi.fn() };
});

const config = { baseURL: "http://provider.test", apiKey: "k" } as AppConfig;

/** Fake Pickers; override only the methods a given test drives. */
function fakePickers(over: Partial<Pickers>): Pickers {
	return { pickOption: async () => null, promptText: async () => null, log: () => {}, ...over } as Pickers;
}

/** Pick the sentinel "Enter a custom model id..." row from whatever list is shown. */
function pickCustomRow(options: PickOption<unknown>[]): unknown {
	const row = options.find((o) => typeof o.value === "object" && o.value !== null && "custom" in o.value);
	return row?.value ?? null;
}

beforeEach(() => {
	vi.mocked(fetchModels).mockReset();
	vi.mocked(runOnboardingCheck).mockReset();
});

describe("selectModel — custom model entry", () => {
	it("validates a typed-in id and returns it only after the check passes", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "listed-model" }] });
		vi.mocked(runOnboardingCheck).mockResolvedValue(true);

		const pickers = fakePickers({
			pickOption: (async (options: PickOption<unknown>[]) => pickCustomRow(options)) as Pickers["pickOption"],
			promptText: async () => "vendor/custom-model",
		});

		const sel = await selectModel(config, pickers);
		expect(vi.mocked(runOnboardingCheck)).toHaveBeenCalledWith(config, "vendor/custom-model", expect.anything());
		expect(sel).toEqual({ model: "vendor/custom-model" });
	});

	it("does not apply an invalid typed-in id (null when the user then cancels)", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "listed-model" }] });
		vi.mocked(runOnboardingCheck).mockResolvedValue(false); // provider rejects it

		let prompts = 0;
		const pickers = fakePickers({
			pickOption: (async (options: PickOption<unknown>[]) => pickCustomRow(options)) as Pickers["pickOption"],
			// Type a bad id once; on the retry re-open, cancel (Escape).
			promptText: async () => (++prompts === 1 ? "bogus-model" : null),
		});

		const sel = await selectModel(config, pickers);
		expect(vi.mocked(runOnboardingCheck)).toHaveBeenCalledWith(config, "bogus-model", expect.anything());
		expect(sel).toBeNull();
	});

	it("treats a blank submit as cancel and never validates", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "listed-model" }] });

		const pickers = fakePickers({
			pickOption: (async (options: PickOption<unknown>[]) => pickCustomRow(options)) as Pickers["pickOption"],
			promptText: async () => "   ",
		});

		const sel = await selectModel(config, pickers);
		expect(vi.mocked(runOnboardingCheck)).not.toHaveBeenCalled();
		expect(sel).toBeNull();
	});

	it("goes straight to custom entry when the provider lists no models", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: false, error: "no /v1/models" });
		vi.mocked(runOnboardingCheck).mockResolvedValue(true);

		let pickCalls = 0;
		const pickers = fakePickers({
			pickOption: (async () => {
				pickCalls++;
				return null;
			}) as Pickers["pickOption"],
			promptText: async () => "only-way-in",
		});

		const sel = await selectModel(config, pickers);
		expect(pickCalls).toBe(0); // no one-row menu — jumped to input
		expect(sel).toEqual({ model: "only-way-in" });
	});

	it("still validates a model picked from the list", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "listed-model", contextWindow: 4096 }] });
		vi.mocked(runOnboardingCheck).mockResolvedValue(true);

		const pickers = fakePickers({
			pickOption: (async (options: PickOption<unknown>[]) =>
				options.find((o) => (o.value as { model?: string }).model === "listed-model")?.value ??
				null) as Pickers["pickOption"],
		});

		const sel = await selectModel(config, pickers);
		expect(vi.mocked(runOnboardingCheck)).toHaveBeenCalledWith(config, "listed-model", expect.anything());
		expect(sel).toEqual({ model: "listed-model", reasoningMeta: undefined, contextWindow: 4096 });
	});

	it("carries the failure reason into the retry picker's red error field so it stays visible", async () => {
		vi.mocked(fetchModels).mockResolvedValue({ ok: true, models: [{ id: "gone-model" }] });
		// Validation fails while logging a specific reason (as runOnboardingCheck does).
		vi.mocked(runOnboardingCheck).mockImplementation(async (_config, _model, opts) => {
			opts?.log?.('Model "gone-model": failed — Model "gone-model" not found. Check the model name.');
			return false;
		});

		const errors: (string | undefined)[] = [];
		let opens = 0;
		const pickers = fakePickers({
			pickOption: (async (options: PickOption<unknown>[], opts?: { error?: string }) => {
				errors.push(opts?.error);
				opens++;
				// 1st open: pick the listed model → fails validation. 2nd open: cancel.
				if (opens === 1) {
					return options.find((o) => (o.value as { model?: string }).model === "gone-model")?.value ?? null;
				}
				return null;
			}) as Pickers["pickOption"],
		});

		const sel = await selectModel(config, pickers);
		expect(sel).toBeNull();
		expect(opens).toBe(2); // re-opened after the failure
		expect(errors[0]).toBeUndefined(); // first open: no error yet
		expect(errors[1]).toContain("not found"); // retry open: reason in the red error field
	});
});
