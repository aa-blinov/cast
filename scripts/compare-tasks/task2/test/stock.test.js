import test from "node:test";
import assert from "node:assert/strict";
import { reserve } from "../src/stock.js";

test("reserve removes units", () => {
	const stock = new Map([["bolt", 5]]);
	reserve(stock, "bolt", 2);
	assert.equal(stock.get("bolt"), 3);
});

test("reserve refuses to go below zero", () => {
	const stock = new Map([["bolt", 1]]);
	assert.throws(() => reserve(stock, "bolt", 2), /not enough stock/);
});
