import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";

/** What a short name stands for: they run when typed, but take no row of their own in the list. */
const ALIASES: Record<string, string> = { s: "steer", q: "queue", qr: "queue-reset" };

/**
 * The commands as the palette lists them. A subcommand (`skills-sh install`) is not a row of its own: its parent
 * names it in its description (`… [install | list-available]`), as one row per variant buried the commands (`/s` gave
 * twenty-five). An alias (`/s`) is told in the description of what it stands for and takes no row; it runs when
 * typed in full.
 */
export function foldCommandVariants(commands: SlashCommand[]): SlashCommand[] {
	const parents = new Set(commands.filter((c) => !c.name.includes(" ")).map((c) => c.name));
	const subs = new Map<string, string[]>();
	const kept: SlashCommand[] = [];
	for (const command of commands) {
		const [head = "", ...rest] = command.name.split(" ");
		if (rest.length > 0 && parents.has(head)) {
			subs.set(head, [...(subs.get(head) ?? []), rest.join(" ")]);
			continue;
		}
		if (ALIASES[command.name] && parents.has(ALIASES[command.name]!)) continue;
		kept.push(command);
	}
	const aliasesOf = (name: string) =>
		Object.entries(ALIASES)
			.filter(([, target]) => target === name)
			.map(([alias]) => `/${alias}`);
	return kept.map((command) => {
		const variants = subs.get(command.name);
		const aliases = aliasesOf(command.name);
		const notes = [
			variants ? `[${variants.join(" | ")}]` : "",
			aliases.length ? `(${aliases.join(", ")})` : "",
		].filter(Boolean);
		if (notes.length === 0) return command;
		return { ...command, description: [command.description, ...notes].filter(Boolean).join(" ") };
	});
}

/** Commands worth having first when a slash is typed and nothing else: the ones most reached for. */
export const PINNED_COMMANDS = ["help", "new", "sessions", "compact", "review"];

/**
 * The order of the palette. With letters typed, what starts with them comes before what merely contains them in
 * order (`/mo` is `model`, not `queue-remove`), the exact name first; with none, the pinned commands come first.
 * Every other row keeps its place.
 */
export function orderSlashSuggestions(items: AutocompleteItem[], typed: string): AutocompleteItem[] {
	const word = typed.toLowerCase();
	const name = (item: AutocompleteItem) => item.value.replace(/^\//, "").toLowerCase();
	const rank = (item: AutocompleteItem): number => {
		if (word === "") {
			const at = PINNED_COMMANDS.indexOf(name(item));
			return at === -1 ? PINNED_COMMANDS.length : at;
		}
		if (name(item) === word) return 0;
		return name(item).startsWith(word) ? 1 : 2;
	};
	return items
		.map((item, index) => ({ item, index, rank: rank(item) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item);
}
