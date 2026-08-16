import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addMarketplace,
	installPlugin,
	listInstalledPlugins,
	listKnownMarketplaces,
	type PluginsPaths,
	parsePluginRef,
	pluginSkillContributions,
	pluginSkillDirs,
	removeMarketplace,
	setPluginEnabled,
	uninstallPlugin,
} from "../src/core/plugins.ts";
import { loadSkills } from "../src/core/skills.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_plugins__");

function paths(): PluginsPaths {
	return { root: join(TEST_DIR, "plugins-home") };
}

function writeMarketplace(dir: string): void {
	mkdirSync(join(dir, ".cast-plugin"), { recursive: true });
	mkdirSync(join(dir, "plugins", "hello", "skills", "greet"), { recursive: true });
	writeFileSync(
		join(dir, ".cast-plugin", "marketplace.json"),
		JSON.stringify(
			{
				name: "ponytail",
				description: "Test marketplace",
				plugins: [
					{
						name: "ponytail",
						description: "Demo plugin",
						source: "./plugins/ponytail",
					},
					{
						name: "hello",
						description: "Hello skills plugin",
						source: "./plugins/hello",
					},
				],
			},
			null,
			2,
		),
		"utf-8",
	);
	mkdirSync(join(dir, "plugins", "ponytail", "skills", "pony"), { recursive: true });
	writeFileSync(
		join(dir, "plugins", "ponytail", "skills", "pony", "SKILL.md"),
		"---\nname: pony\ndescription: Pony skill from plugin.\n---\n\nSay neigh.\n",
		"utf-8",
	);
	writeFileSync(
		join(dir, "plugins", "hello", "skills", "greet", "SKILL.md"),
		"---\nname: greet\ndescription: Greets the user.\n---\n\nSay hello.\n",
		"utf-8",
	);
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parsePluginRef", () => {
	it("parses name@marketplace", () => {
		expect(parsePluginRef("ponytail@ponytail")).toEqual({ plugin: "ponytail", marketplace: "ponytail" });
		expect(parsePluginRef("superpowers@xai-official")).toEqual({
			plugin: "superpowers",
			marketplace: "xai-official",
		});
	});

	it("rejects bad refs", () => {
		expect(parsePluginRef("nopony")).toBeNull();
		expect(parsePluginRef("@ponytail")).toBeNull();
		expect(parsePluginRef("ponytail@")).toBeNull();
	});
});

describe("marketplace + install (local)", () => {
	it("adds a local marketplace and installs ponytail@ponytail", async () => {
		const mpDir = join(TEST_DIR, "mp");
		writeMarketplace(mpDir);
		const p = paths();

		const known = await addMarketplace(mpDir, p);
		expect(known.name).toBe("ponytail");
		expect(listKnownMarketplaces(p).map((m) => m.name)).toEqual(["ponytail"]);

		const installed = await installPlugin("ponytail@ponytail", {}, p);
		expect(installed.id).toBe("ponytail@ponytail");
		expect(installed.enabledPlugins["ponytail@ponytail"]).toBe(true);

		const list = listInstalledPlugins({ enabledPlugins: installed.enabledPlugins }, p);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe("ponytail@ponytail");

		const dirs = pluginSkillDirs({ enabledPlugins: installed.enabledPlugins }, p);
		expect(dirs.length).toBe(1);
		const { skills } = loadSkills({ pluginDirs: dirs, extraPaths: [] });
		expect(skills.map((s) => s.name).sort()).toEqual(["pony"]);
		expect(skills[0]!.source).toBe("plugin");
	});

	it("uninstall removes the plugin and skill dirs", async () => {
		const mpDir = join(TEST_DIR, "mp");
		writeMarketplace(mpDir);
		const p = paths();
		await addMarketplace(mpDir, p);
		const installed = await installPlugin("hello@ponytail", {}, p);
		const after = uninstallPlugin("hello@ponytail", { enabledPlugins: installed.enabledPlugins }, p);
		expect(after.enabledPlugins["hello@ponytail"]).toBeUndefined();
		expect(listInstalledPlugins({ enabledPlugins: after.enabledPlugins }, p)).toHaveLength(0);
		expect(pluginSkillDirs({ enabledPlugins: after.enabledPlugins }, p)).toHaveLength(0);
	});

	it("disabled plugin stays in contributions but not in enabled skill dirs", async () => {
		const mpDir = join(TEST_DIR, "mp");
		writeMarketplace(mpDir);
		const p = paths();
		await addMarketplace(mpDir, p);
		const installed = await installPlugin("ponytail@ponytail", {}, p);
		expect(pluginSkillDirs({ enabledPlugins: installed.enabledPlugins }, p)).toHaveLength(1);

		const disabled = setPluginEnabled("ponytail@ponytail", false, {
			enabledPlugins: installed.enabledPlugins,
		});
		expect(pluginSkillDirs({ enabledPlugins: disabled.enabledPlugins }, p)).toHaveLength(0);
		const contribs = pluginSkillContributions({ enabledPlugins: disabled.enabledPlugins }, p);
		expect(contribs).toHaveLength(1);
		expect(contribs[0]).toMatchObject({ pluginId: "ponytail@ponytail", enabled: false });
		const { skills } = loadSkills({ pluginContributions: contribs, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "pony",
			source: "plugin",
			pluginId: "ponytail@ponytail",
			pluginEnabled: false,
		});

		const reenabled = setPluginEnabled("ponytail@ponytail", true, {
			enabledPlugins: disabled.enabledPlugins,
		});
		const dirs = pluginSkillDirs({ enabledPlugins: reenabled.enabledPlugins }, p);
		expect(dirs).toHaveLength(1);
		const loaded = loadSkills({ pluginDirs: dirs, extraPaths: [] });
		expect(loaded.skills.map((s) => s.name)).toEqual(["pony"]);
	});

	it("removeMarketplace drops installs and returns removed plugin ids", async () => {
		const mpDir = join(TEST_DIR, "mp");
		writeMarketplace(mpDir);
		const p = paths();
		await addMarketplace(mpDir, p);
		await installPlugin("hello@ponytail", {}, p);
		expect(listInstalledPlugins({}, p)).toHaveLength(1);
		const removed = removeMarketplace("ponytail", p);
		expect(removed).toEqual(["hello@ponytail"]);
		expect(listInstalledPlugins({}, p)).toHaveLength(0);
		expect(listKnownMarketplaces(p)).toEqual([]);
	});

	it("removeMarketplace refuses a default marketplace", async () => {
		const mpDir = join(TEST_DIR, "default-mp");
		writeMarketplace(mpDir);
		const p = paths();
		await addMarketplace(mpDir, p, { isDefault: true });
		expect(() => removeMarketplace("ponytail", p)).toThrow(/can't be removed/);
		expect(listKnownMarketplaces(p)).toHaveLength(1);
	});
});

describe("ensureDefaultMarketplaces", () => {
	it("adds missing defaults, marks them isDefault, and is a no-op once all exist", async () => {
		const { ensureDefaultMarketplaces } = await import("../src/core/plugins.ts");
		const mpDir = join(TEST_DIR, "default-mp-2");
		writeMarketplace(mpDir);
		const p = paths();

		const first = await ensureDefaultMarketplaces(p, [{ source: mpDir, label: "test" }]);
		expect(first.added.some((a) => a.includes("ponytail"))).toBe(true);
		expect(first.errors).toEqual([]);
		const known = listKnownMarketplaces(p);
		expect(known).toHaveLength(1);
		expect(known[0]).toMatchObject({ name: "ponytail", isDefault: true });

		const second = await ensureDefaultMarketplaces(p, [{ source: mpDir, label: "test" }]);
		expect(second.added).toEqual([]);
		expect(second.errors).toEqual([]);
		expect(listKnownMarketplaces(p)).toHaveLength(1);
	});
});

describe("stagingNameFor", () => {
	it("derives a safe name from GitHub slugs and git URLs", async () => {
		const { stagingNameFor } = await import("../src/core/plugins.ts");
		expect(stagingNameFor("acme/market")).toBe("market");
		expect(stagingNameFor("https://github.com/acme/market.git")).toBe("market");
	});

	it("never leaks backslashes or colons from Windows local paths", async () => {
		const { stagingNameFor } = await import("../src/core/plugins.ts");
		expect(stagingNameFor("C:\\dev\\my-marketplace")).toBe("my-marketplace");
		expect(stagingNameFor("C:\\")).toBe("C-");
	});
});
