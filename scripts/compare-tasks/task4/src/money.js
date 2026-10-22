// Money is stored in cents, as an integer.

export function toCents(amount) {
	return Math.round(amount * 100);
}

export function formatCents(cents) {
	const sign = cents < 0 ? "-" : "";
	const absolute = Math.abs(cents);
	return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
