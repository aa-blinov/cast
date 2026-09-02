import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkpointFork,
	checkpointPushCapsSetting,
	checkpointReservedSetting,
	checkpointThresholdsSetting,
	getProjectTrust,
	isMemoryEnabled,
	isMemoryWriteEnabled,
	loadSettings,
	memoryDistillAuto,
	memoryDistillIntervalDays,
	memoryDreamAuto,
	memoryDreamIntervalDays,
	memoryPromptBudget,
	memoryReconcileOnSearch,
	memorySearchScoreFloor,
	type Provider,
	setProjectTrust,
	updateSettings,
} from "../src/core/settings.ts";

describe("settings", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-settings-test-"));
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	describe("a corrupt settings.json", () => {
		it("is preserved instead of being silently overwritten by the next update", () => {
			// loadSettings() degrades to {} on a parse error, and updateSettings
			// merges over that — which used to write the empty state out as the
			// whole file, destroying every provider entry and API key. The
			// daemon itself calls updateSettings during an ordinary turn, so a
			// single hand-edit typo was enough to lose them with no warning.
			const settingsDir = join(fakeHome, ".cast");
			mkdirSync(settingsDir, { recursive: true });
			const path = join(settingsDir, "settings.json");
			const original =
				'{\n  "model": "some-model",\n  "providers": [{ "name": "p", "url": "u", "apiKey": "sk-real-secret" }],\n}';
			writeFileSync(path, original);

			expect(loadSettings()).toEqual({});
			updateSettings({ reasoningLevel: "high" });

			// The update went through, so the daemon keeps working...
			expect(loadSettings().reasoningLevel).toBe("high");
			// ...and the unreadable original is still on disk, verbatim.
			const quarantined = readdirSync(settingsDir).filter((f) => f.startsWith("settings.json.corrupt-"));
			expect(quarantined).toHaveLength(1);
			expect(readFileSync(join(settingsDir, quarantined[0]!), "utf-8")).toBe(original);
		});

		it("leaves a readable settings.json alone", () => {
			updateSettings({ model: "m1", providers: [{ name: "p", url: "u", apiKey: "k" }] });
			updateSettings({ reasoningLevel: "low" });

			expect(loadSettings()).toMatchObject({ model: "m1", reasoningLevel: "low" });
			expect(loadSettings().providers).toHaveLength(1);
			expect(readdirSync(join(fakeHome, ".cast")).filter((f) => f.includes(".corrupt-"))).toHaveLength(0);
		});
	});

	describe("project trust", () => {
		it("is undefined (never asked) for a project with no recorded decision", () => {
			expect(getProjectTrust(loadSettings(), "/some/project")).toBeUndefined();
		});

		it("persists a trust decision across loadSettings() calls", () => {
			setProjectTrust("/some/project", true);
			expect(getProjectTrust(loadSettings(), "/some/project")).toBe(true);
		});

		it("keeps decisions for different projects independent", () => {
			setProjectTrust("/project/a", true);
			setProjectTrust("/project/b", false);
			const settings = loadSettings();
			expect(getProjectTrust(settings, "/project/a")).toBe(true);
			expect(getProjectTrust(settings, "/project/b")).toBe(false);
		});

		it("overwrites a prior decision for the same project", () => {
			setProjectTrust("/some/project", true);
			setProjectTrust("/some/project", false);
			expect(getProjectTrust(loadSettings(), "/some/project")).toBe(false);
		});
	});

	describe("provider migration", () => {
		function writeSettings(data: Record<string, unknown>) {
			const dir = join(fakeHome, ".cast");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "settings.json"), JSON.stringify(data));
		}

		it("migrates legacy providerUrl + apiKey to providers array", () => {
			writeSettings({ providerUrl: "https://api.openai.com/v1", apiKey: "sk-test123" });
			const s = loadSettings();
			expect(s.providers).toEqual([{ name: "default", url: "https://api.openai.com/v1", apiKey: "sk-test123" }]);
		});

		it("leaves existing providers array untouched", () => {
			const existing: Provider[] = [
				{ name: "openrouter", url: "https://openrouter.ai/api/v1", apiKey: "sk-or-123" },
			];
			writeSettings({ providerUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-123", providers: existing });
			const s = loadSettings();
			expect(s.providers).toEqual(existing);
		});

		it("repairs a stale main provider name when the active credentials identify another row", () => {
			const providers: Provider[] = [
				{ name: "old", url: "https://old.example/v1", apiKey: "old-key" },
				{ name: "minimax", url: "https://api.minimax.io/v1", apiKey: "minimax-key" },
			];
			writeSettings({
				providerUrl: "https://api.minimax.io/v1",
				apiKey: "minimax-key",
				modelProvider: "old",
				providers,
			});

			expect(loadSettings().modelProvider).toBe("minimax");
		});

		it("does nothing when neither providerUrl nor providers exist", () => {
			writeSettings({});
			const s = loadSettings();
			expect(s.providers).toBeUndefined();
		});
	});

	describe("providers (via updateSettings)", () => {
		it("persists providers array atomically", () => {
			const providers: Provider[] = [
				{ name: "a", url: "https://a.example", apiKey: "key-a" },
				{ name: "b", url: "https://b.example", apiKey: "key-b" },
			];
			updateSettings({ providers });
			expect(loadSettings().providers).toEqual(providers);
		});

		// updateSettings({ x: undefined }) ERASES the existing key: spread
		// overwrites the value, and JSON.stringify then drops the property.
		// Callers can't "clear" a field by passing undefined; they have to
		// overwrite it with a real value (the /provider delete-of-last-active
		// path uses "" so migrateProviders doesn't resurrect a dead provider).
		it("updateSettings({ x: undefined }) erases the existing key", () => {
			const dir = join(fakeHome, ".cast");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ providerUrl: "https://a.example", apiKey: "k-a" }));
			updateSettings({ providerUrl: undefined });
			const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")) as Record<string, unknown>;
			expect(raw.providerUrl).toBeUndefined();
			expect(raw.apiKey).toBe("k-a");
		});
	});

	describe("memory", () => {
		it("is enabled for existing settings that have no memory flag", () => {
			expect(isMemoryEnabled(loadSettings())).toBe(true);
		});

		it("persists a global disabled state", () => {
			updateSettings({ memoryEnabled: false });
			expect(isMemoryEnabled(loadSettings())).toBe(false);
		});

		it("keeps memory readable when background writing is disabled", () => {
			expect(isMemoryWriteEnabled({ memoryEnabled: true, memoryWriteEnabled: false })).toBe(false);
			expect(isMemoryEnabled({ memoryEnabled: true, memoryWriteEnabled: false })).toBe(true);
		});

		it("normalizes memory controls to safe bounds and defaults", () => {
			expect(memoryPromptBudget({})).toBe(4096);
			expect(memoryPromptBudget({ memoryPromptBudget: 99 })).toBe(256);
			expect(memoryPromptBudget({ memoryPromptBudget: 99_999 })).toBe(16_384);
			expect(memorySearchScoreFloor({ memorySearchScoreFloor: -1 })).toBe(0);
			expect(memorySearchScoreFloor({ memorySearchScoreFloor: 2 })).toBe(1);
			expect(memoryReconcileOnSearch({ memoryReconcileOnSearch: false })).toBe(false);
		});

		it("keeps automatic dream and distill opt-in with reference intervals", () => {
			expect(memoryDreamAuto({})).toBe(false);
			expect(memoryDistillAuto({})).toBe(false);
			expect(memoryDreamIntervalDays({})).toBe(7);
			expect(memoryDistillIntervalDays({})).toBe(30);
			expect(memoryDreamIntervalDays({ memoryDreamIntervalDays: -1 })).toBe(0);
			expect(memoryDistillIntervalDays({ memoryDistillIntervalDays: 3.7 })).toBe(3);
		});

		it("defaults to no prefix fork", () => {
			expect(checkpointFork({})).toBe(false);
			expect(checkpointFork({ checkpointFork: true })).toBe(true);
		});

		it("parses checkpoint thresholds, reserved, and push caps from settings", () => {
			expect(checkpointThresholdsSetting({})).toBeUndefined();
			expect(checkpointThresholdsSetting({ checkpointThresholds: [40, 20, 40, 101, -5] })).toEqual([20, 40]);
			expect(checkpointReservedSetting({})).toBeUndefined();
			expect(checkpointReservedSetting({ checkpointReserved: 20_000.7 })).toBe(20_000);
			expect(checkpointPushCapsSetting({})).toBeUndefined();
			expect(
				checkpointPushCapsSetting({
					checkpointPushCaps: { checkpoint: 11_000, memory: 0, notes: 6_000.9, unknown: 99 },
				}),
			).toEqual({ checkpoint: 11_000, notes: 6_000 });
		});
	});

	describe("updateSettings concurrency", () => {
		// A caller that reads settings, derives a new array/Set from it, and
		// only later (after an await — e.g. bridge.ts's /provider switch
		// probes the endpoint before writing) calls updateSettings() with a
		// plain object is reading a value that can go stale: another update
		// can land in between, and this caller's write silently overwrites it
		// with a version that never saw the other change. The functional form
		// reads `current` from *inside* updateSettings' own lock, so nothing
		// else can land between the read and the write no matter what the
		// caller awaited beforehand.
		it("a plain-object update racing another one across an await gap loses whichever wrote first", async () => {
			updateSettings({ disabledHooks: [] });
			const disableTheOldWay = (id: string) =>
				new Promise<void>((resolve) => {
					setTimeout(async () => {
						const current = loadSettings();
						// The await gap a real caller has for a different reason
						// (network probe, subprocess spawn, ...) — this is what
						// lets another update's write land before this one, with
						// nothing to notice `current` is now stale.
						await new Promise((r) => setTimeout(r, 0));
						updateSettings({ disabledHooks: [...(current.disabledHooks ?? []), id] });
						resolve();
					}, 0);
				});

			await Promise.all([disableTheOldWay("hookA"), disableTheOldWay("hookB")]);

			// Only one of the two survives — the plain-object form has no
			// defense against this regardless of how it's called.
			expect(loadSettings().disabledHooks?.length).toBe(1);
		});

		it("the functional form survives the same race — reading current settings from inside the lock instead", async () => {
			updateSettings({ disabledHooks: [] });
			const disable = (id: string) =>
				new Promise<void>((resolve) => {
					setTimeout(async () => {
						await new Promise((r) => setTimeout(r, 0));
						updateSettings((current) => ({ disabledHooks: [...(current.disabledHooks ?? []), id] }));
						resolve();
					}, 0);
				});

			await Promise.all([disable("hookA"), disable("hookB")]);

			expect(loadSettings().disabledHooks?.slice().sort()).toEqual(["hookA", "hookB"]);
		});
	});
});
