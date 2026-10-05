import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../src/ui/commands.ts";
import { foldCommandVariants, orderSlashSuggestions, PINNED_COMMANDS } from "../src/ui-pi/command-palette.ts";
import { CastAutocompleteProvider } from "../src/ui-pi/editor.ts";

const item = (name: string) => ({ value: name, label: name });

describe("foldCommandVariants", () => {
	it("names a command's subcommands and aliases in its own description, and gives them no rows", () => {
		const out = foldCommandVariants([
			{ name: "skills-sh", description: "skills.sh" },
			{ name: "skills-sh install", description: "install" },
			{ name: "skills-sh search", description: "search" },
			{ name: "steer", description: "Inject a message" },
			{ name: "s", description: "steer, short" },
			{ name: "queue", description: "Queue" },
			{ name: "q", description: "queue, short" },
			{ name: "qr", description: "reset, short" },
			{ name: "queue-reset", description: "Clear the queue" },
		]);
		expect(out.map((c) => c.name)).toEqual(["skills-sh", "steer", "queue", "queue-reset"]);
		expect(out.find((c) => c.name === "skills-sh")?.description).toBe("skills.sh [install | search]");
		expect(out.find((c) => c.name === "steer")?.description).toBe("Inject a message (/s)");
		expect(out.find((c) => c.name === "queue-reset")?.description).toBe("Clear the queue (/qr)");
	});

	it("keeps a variant whose parent is not in the list, and a short name that stands for nothing here", () => {
		const out = foldCommandVariants([
			{ name: "worktree list", description: "list" },
			{ name: "s", description: "no steer here" },
		]);
		expect(out.map((c) => c.name)).toEqual(["worktree list", "s"]);
	});
});

describe("orderSlashSuggestions", () => {
	it("puts the exact name, then what starts with the letters, before what only contains them", () => {
		const items = ["queue-remove", "model", "mobile", "mo", "remote", "morning"].map(item);
		expect(orderSlashSuggestions(items, "mo").map((i) => i.value)).toEqual([
			"mo",
			"model",
			"mobile",
			"morning",
			"queue-remove",
			"remote",
		]);
	});

	it("puts the pinned commands first for a bare slash, and leaves every other row where it was", () => {
		const names = ["abort", "compact", "agents", "help", "review", "zeta", "new", "sessions"];
		const ordered = orderSlashSuggestions(names.map(item), "").map((i) => i.value);
		expect(ordered.slice(0, 5)).toEqual(["help", "new", "sessions", "compact", "review"]);
		expect(ordered.slice(5)).toEqual(["abort", "agents", "zeta"]);
		expect(PINNED_COMMANDS).toHaveLength(5);
	});
});

describe("the palette as typed", () => {
	const skills = ["commit-helper", "review-pr"].map((name) => ({ name, description: `skill ${name}` }));
	const provider = new CastAutocompleteProvider(
		[
			...foldCommandVariants(
				SLASH_COMMANDS.filter((c) => !c.hidden).map((c) => ({ name: c.name.slice(1), description: c.description })),
			),
			...skills,
		],
		"/tmp",
		null,
		new Set(SLASH_COMMANDS.filter((c) => c.hidden && !c.name.includes(" ")).map((c) => c.name.slice(1))),
		skills,
	);
	const ask = async (text: string) =>
		(await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal }))?.items.map(
			(i) => i.label,
		) ?? [];

	it("opens with the pinned commands and then the rest in order, with no row for a subcommand or an alias", async () => {
		const all = await ask("/");
		expect(all.slice(0, 5)).toEqual(PINNED_COMMANDS);
		expect(all.some((n) => n.includes(" "))).toBe(false);
		expect(all).not.toContain("s");
		const rest = all.slice(5, all.indexOf("commit-helper"));
		expect(rest).toEqual([...rest].sort());
	});

	it("lists what starts with the letters first, builtins before skills", async () => {
		const found = await ask("/re");
		const lastPrefix = found.findLastIndex((n) => n.startsWith("re"));
		expect(found.slice(0, lastPrefix + 1).every((n) => n.startsWith("re"))).toBe(true);
		expect(found.indexOf("review")).toBeLessThan(found.indexOf("review-pr"));
		expect(await ask("/q")).toEqual(expect.arrayContaining(["queue", "queue-reset"]));
		expect((await ask("/s")).slice(0, 4)).toEqual(expect.arrayContaining(["scratchpad", "sessions", "settings"]));
	});

	it("says a subcommand where the command is", async () => {
		const row = (await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal }))?.items.find(
			(i) => i.label === "worktree",
		);
		expect(row?.description).toContain("[list | remove]");
	});
});
