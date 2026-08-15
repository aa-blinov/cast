import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
