import test from "node:test";
import assert from "node:assert/strict";
import { applyEvents, totalUnits, lowStock, snapshot } from "../src/inventory.js";

test("applies deltas per sku", () => {
	const stock = applyEvents([
		{ sku: "bolt", delta: 5 },
		{ sku: "nut", delta: -2 },
		{ sku: "bolt", delta: 3 },
	]);
	assert.equal(stock.get("bolt"), 8);
	assert.equal(stock.get("nut"), -2);
});

test("totals the units", () => {
	assert.equal(totalUnits(new Map([["bolt", 8], ["nut", 3]])), 11);
	assert.equal(totalUnits(new Map()), 0);
});

test("lists skus at or below the threshold, sorted", () => {
	const stock = new Map([
		["washer", 2],
		["bolt", 9],
		["nut", 5],
	]);
	assert.deepEqual(lowStock(stock, 5), ["nut", "washer"]);
});

test("snapshots in a stable order", () => {
	assert.equal(
		JSON.stringify(snapshot(new Map([["nut", 1], ["bolt", 2]]))),
		JSON.stringify({ bolt: 2, nut: 1 }),
	);
});
