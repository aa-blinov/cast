// Parses the tiny CSV-ish report format: "name,amount,date" per line.

export function parseLines(text) {
	const rows = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const [name, amount, date] = line.split(",");
		rows.push({ name, amount: Number(amount), date });
	}
	return rows;
}
