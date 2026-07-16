import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectTrust, loadSettings, type Provider, setProjectTrust, updateSettings } from "../src/core/settings.ts";

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
});
