import test from "node:test";
import assert from "node:assert/strict";
import { summarise, parseLines } from "../src/index.js";

test("parses rows", () => {
	assert.deepEqual(parseLines("a,2,2026-01-01"), [{ name: "a", amount: 2, date: "2026-01-01" }]);
});

test("parses rows with CRLF line endings", () => {
	assert.deepEqual(parseLines("a,2,2026-01-01\r\nb,3,2026-01-02"), [
		{ name: "a", amount: 2, date: "2026-01-01" },
		{ name: "b", amount: 3, date: "2026-01-02" },
	]);
});

test("sums the amounts", () => {
	assert.deepEqual(summarise("a,2,2026-01-01\r\nb,3,2026-01-02"), { rows: 2, total: 5 });
});

test("ignores blank lines", () => {
	assert.deepEqual(summarise("a,2,2026-01-01\n\nb,3,2026-01-02"), { rows: 2, total: 5 });
});
