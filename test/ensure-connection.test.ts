import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pickers } from "../src/pickers/types.ts";

// Stub the network probe and the settings writer; reconfigureConnection stays
// real (driven by fake pickers) so we test the recovery loop's actual wiring.
vi.mock("../src/core/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/config.ts")>();
	return { ...actual, probeProvider: vi.fn() };
});
vi.mock("../src/core/settings.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/settings.ts")>();
	return { ...actual, updateSettings: vi.fn() };
});

const { ensureConnectionAlive } = await import("../src/core/startup.ts");
const { probeProvider } = await import("../src/core/config.ts");
const { updateSettings } = await import("../src/core/settings.ts");

const probe = vi.mocked(probeProvider);
const upd = vi.mocked(updateSettings);

const config = () =>
	({ baseURL: "https://old.example/v1", apiKey: "sk-old" }) as Parameters<typeof ensureConnectionAlive>[0];

/** Fake pickers whose promptText hands back queued answers in call order. */
function promptPickers(answers: (string | null)[]): Pickers {
	let i = 0;
	return {
		pickOption: async () => null,
		promptText: async () => answers[i++] ?? null,
		log: () => {},
	} as unknown as Pickers;
}

beforeEach(() => {
	probe.mockReset();
	upd.mockReset();
});

describe("ensureConnectionAlive", () => {
	it("returns changed=false and never re-prompts when the connection is already ok", async () => {
		probe.mockResolvedValue("ok");
		expect(await ensureConnectionAlive(config(), promptPickers([]))).toBe(false);
		expect(upd).not.toHaveBeenCalled();
	});

	it("leaves an unclassifiable (unknown) provider alone — no nagging", async () => {
		probe.mockResolvedValue("unknown");
		expect(await ensureConnectionAlive(config(), promptPickers([]))).toBe(false);
		expect(upd).not.toHaveBeenCalled();
	});

	it("re-prompts on auth failure, applies + persists new creds, and reports changed=true", async () => {
		probe.mockResolvedValueOnce("auth").mockResolvedValueOnce("ok");
		const cfg = config();
		const changed = await ensureConnectionAlive(cfg, promptPickers(["https://new.example/v1", "sk-new"]));
		expect(changed).toBe(true);
		expect(cfg.baseURL).toBe("https://new.example/v1");
		expect(cfg.apiKey).toBe("sk-new");
		expect(upd).toHaveBeenCalledWith(
			expect.objectContaining({ providerUrl: "https://new.example/v1", apiKey: "sk-new" }),
		);
	});

	it("keeps looping while the connection stays bad, applying each new key", async () => {
		probe.mockResolvedValueOnce("auth").mockResolvedValueOnce("auth").mockResolvedValueOnce("ok");
		const cfg = config();
		const changed = await ensureConnectionAlive(
			cfg,
			promptPickers(["https://a.example/v1", "sk-1", "https://b.example/v1", "sk-2"]),
		);
		expect(changed).toBe(true);
		expect(cfg.apiKey).toBe("sk-2");
		expect(probe).toHaveBeenCalledTimes(3);
	});

	it("exits when the user cancels the credential prompt", async () => {
		probe.mockResolvedValue("auth");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit(0)");
		});
		try {
			await expect(ensureConnectionAlive(config(), promptPickers([null]))).rejects.toThrow("exit(0)");
			expect(exitSpy).toHaveBeenCalledWith(0);
		} finally {
			exitSpy.mockRestore();
		}
	});
});
