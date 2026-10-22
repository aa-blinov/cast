export function validateLine(line) {
	if (!line.sku) return "missing sku";
	if (!Number.isInteger(line.quantity) || line.quantity <= 0) return "quantity must be a positive integer";
	if (line.unitPrice < 0) return "unit price must not be negative";
	return null;
}

export function validateInvoice(lines) {
	const problems = [];
	for (const line of lines) {
		const problem = validateLine(line);
		if (problem) problems.push(`${line.sku ?? "(no sku)"}: ${problem}`);
	}
	return problems;
}
