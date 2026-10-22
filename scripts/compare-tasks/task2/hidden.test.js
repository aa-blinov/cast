import test from "node:test";
import assert from "node:assert/strict";
import { restock } from "../src/stock.js";

test("restock adds units to an existing sku", () => {
	const stock = new Map([["bolt", 2]]);
	const same = restock(stock, "bolt", 3);
	assert.equal(stock.get("bolt"), 5);
	assert.equal(same, stock);
});

test("restock treats a missing sku as zero", () => {
	const stock = new Map();
	restock(stock, "nut", 4);
	assert.equal(stock.get("nut"), 4);
});

test("restock refuses units that are not positive integers", () => {
	assert.throws(() => restock(new Map(), "bolt", 0), /positive integer/);
	assert.throws(() => restock(new Map(), "bolt", -1), /positive integer/);
	assert.throws(() => restock(new Map(), "bolt", 1.5), /positive integer/);
});
