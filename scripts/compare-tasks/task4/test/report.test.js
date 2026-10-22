import test from "node:test";
import assert from "node:assert/strict";
import { renderInvoice } from "../src/report.js";

test("renders the three lines", () => {
	const text = renderInvoice([{ sku: "a", unitPrice: 10, quantity: 1 }], "standard");
	assert.equal(text, "net   $10.00\ntax   $2.00\ngross $12.00");
});
