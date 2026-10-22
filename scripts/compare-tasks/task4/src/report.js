import { formatCents } from "./money.js";
import { invoiceTotal } from "./invoice.js";

export function renderInvoice(lines, rateName) {
	const { net, tax, gross } = invoiceTotal(lines, rateName);
	return [
		`net   ${formatCents(net)}`,
		`tax   ${formatCents(tax)}`,
		`gross ${formatCents(gross)}`,
	].join("\n");
}
