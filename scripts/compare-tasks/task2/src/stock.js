// Stock helpers. `reserve` is done; `restock` is not written yet.

export function reserve(stock, sku, units) {
	const current = stock.get(sku) ?? 0;
	if (current < units) throw new Error(`not enough stock for ${sku}`);
	stock.set(sku, current - units);
	return stock;
}
