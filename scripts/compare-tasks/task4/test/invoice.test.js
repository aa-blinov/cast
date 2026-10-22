import test from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal, lineTotal } from "../src/invoice.js";

test("adds up a line", () => {
	assert.equal(lineTotal({ sku: "a", unitPrice: 2.5, quantity: 4 }), 1000);
});

test("adds tax to the net", () => {
	const total = invoiceTotal([{ sku: "a", unitPrice: 100, quantity: 1 }], "standard");
	assert.deepEqual(total, { net: 10000, tax: 2000, gross: 12000 });
});

test("keeps a cent on odd amounts", () => {
	const total = invoiceTotal([{ sku: "a", unitPrice: 0.1, quantity: 3 }], "standard");
	assert.deepEqual(total, { net: 30, tax: 6, gross: 36 });
});
