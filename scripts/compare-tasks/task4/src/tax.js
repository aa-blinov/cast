import { toCents } from "./money.js";

const RATES = { standard: 0.2, reduced: 0.1, zero: 0 };

/** The tax owed on an amount of cents, at the named rate. */
export function taxFor(amount, rateName) {
	const rate = RATES[rateName];
	if (rate === undefined) throw new Error(`unknown tax rate: ${rateName}`);
	return toCents(amount * rate);
}
