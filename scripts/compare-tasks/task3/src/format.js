import { parseLines } from "./parse.js";

export function summarise(text) {
	const rows = parseLines(text);
	let total = 0;
	for (const row of rows) {
		total += row.amount;
	}
	return { rows: rows.length, total };
}
