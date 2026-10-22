// A tiny inventory ledger: items come in, items go out, and the ledger
// reports what is left.

export function applyEvents(events) {
	const stock = new Map();
	for (const event of events) {
		const { sku, delta } = event;
		stock.set(sku, (stock.get(sku) ?? 0) + delta);
	}
	return stock;
}

export function totalUnits(stock) {
	let total = 0;
	for (const units of stock.values()) {
		total += units;
	}
	return total;
}

export function lowStock(stock, threshold) {
	const low = [];
	for (const [sku, units] of stock) {
		if (units < threshold) low.push(sku);
	}
	return low.sort();
}

export function snapshot(stock) {
	return Object.fromEntries([...stock.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}
