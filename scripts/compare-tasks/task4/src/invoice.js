import { taxFor } from "./tax.js";
import { toCents } from "./money.js";

export function lineTotal(line) {
	return toCents(line.unitPrice) * line.quantity;
}

export function invoiceTotal(lines, rateName) {
	let net = 0;
	for (const line of lines) net += lineTotal(line);
	const tax = taxFor(net / 100, rateName);
	return { net, tax, gross: net + tax };
}
