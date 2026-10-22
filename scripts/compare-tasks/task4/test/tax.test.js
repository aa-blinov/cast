import test from "node:test";
import assert from "node:assert/strict";
import { taxFor } from "../src/tax.js";

test("taxes at the standard rate", () => {
	assert.equal(taxFor(100, "standard"), 20);
});

test("refuses an unknown rate", () => {
	assert.throws(() => taxFor(100, "surprise"), /unknown tax rate/);
});
