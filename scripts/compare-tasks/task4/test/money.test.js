import test from "node:test";
import assert from "node:assert/strict";
import { formatCents, toCents } from "../src/money.js";

test("converts to cents", () => {
	assert.equal(toCents(12.34), 1234);
});

test("formats cents", () => {
	assert.equal(formatCents(1234), "$12.34");
	assert.equal(formatCents(-50), "-$0.50");
});
