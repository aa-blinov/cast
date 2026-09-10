import { describe, expect, it } from "vitest";
import { isNearBottom, isNearTop, scrollTopAfterPrepend, shouldFollow } from "../src/server/public/chat-scroll.js";

describe("isNearBottom", () => {
	it("is true when scrolled exactly to the bottom", () => {
		expect(isNearBottom(920, 80, 1000)).toBe(true);
	});

	it("is true within the default 80px threshold", () => {
		expect(isNearBottom(840, 80, 1000)).toBe(true);
	});

	it("is false once scrolled further than the threshold from the bottom", () => {
		expect(isNearBottom(800, 80, 1000)).toBe(false);
	});

	it("honors a custom threshold", () => {
		expect(isNearBottom(700, 80, 1000, 300)).toBe(true);
		expect(isNearBottom(600, 80, 1000, 300)).toBe(false);
	});
});

describe("isNearTop", () => {
	it("is true at the very top", () => {
		expect(isNearTop(0)).toBe(true);
	});

	it("is true within the default 600px prefetch threshold", () => {
		expect(isNearTop(599)).toBe(true);
	});

	it("is false once scrolled past the threshold", () => {
		expect(isNearTop(600)).toBe(false);
		expect(isNearTop(1000)).toBe(false);
	});
});

describe("scrollTopAfterPrepend", () => {
	it("keeps the visible content in place when content is prepended above it", () => {
		// User was reading at scrollTop 200 out of a 1000px-tall list.
		// Prepending 300px of older messages grows the list to 1300px —
		// scrollTop must grow by exactly that 300px so the same content
		// stays under the viewport instead of the view jumping to it.
		expect(scrollTopAfterPrepend(200, 1300, 1000)).toBe(500);
	});

	it("is a no-op when nothing was actually prepended", () => {
		expect(scrollTopAfterPrepend(200, 1000, 1000)).toBe(200);
	});
});

describe("shouldFollow", () => {
	it("keeps following when a streaming frame grew the list past the threshold before the catch-up scroll", () => {
		// scrollTop unchanged at 500, the list grew from 1000 to 1400: 320px
		// from the bottom, no scroll up happened.
		expect(shouldFollow(true, 500, 500, 80, 1400)).toBe(true);
	});

	it("stops following on a scroll up", () => {
		expect(shouldFollow(true, 400, 500, 80, 1400)).toBe(false);
	});

	it("stays off while scrolling down without reaching the bottom", () => {
		expect(shouldFollow(false, 450, 400, 80, 1400)).toBe(false);
	});

	it("turns back on once near the bottom", () => {
		expect(shouldFollow(false, 1300, 400, 80, 1400)).toBe(true);
	});

	it("ignores the clamp that follows a shrinking list — a reader who scrolled up stays there", () => {
		// Streaming block swapped for a settled message that is laid out as its
		// placeholder for a frame: 4000px → 461px, scrollTop snapped 148 → 0.
		expect(shouldFollow(false, 0, 148, 600, 461, 4000)).toBe(false);
		// And a reader who was following keeps following through it.
		expect(shouldFollow(true, 0, 3400, 600, 461, 4000)).toBe(true);
	});
});
