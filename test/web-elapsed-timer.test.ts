import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("preact/hooks", () => ({ useEffect: () => {}, useState: (value: unknown) => [value, vi.fn()] }), {
	virtual: true,
});

import {
	computeClockOffsetMs,
	computeElapsedMs,
	computeStartMs,
	ElapsedTimer,
	formatElapsed,
	shouldTick,
} from "../src/server/public/elapsed-timer.js";

describe("ElapsedTimer", () => {
	it("is exported as an isolated component", () => {
		expect(typeof ElapsedTimer).toBe("function");
	});
});

describe("computeClockOffsetMs / computeStartMs", () => {
	it("captures how far the client clock is ahead of the server's turnStartedAt", () => {
		// Server said the turn started at server-time 1000; this client's own
		// clock reads 1050 right now — an offset of +50ms.
		const offset = computeClockOffsetMs(1000, 1050);
		expect(offset).toBe(50);
		// That offset re-applied to turnStartedAt gives back the client-clock
		// timestamp the turn "started" at, from this client's point of view.
		expect(computeStartMs(1000, offset)).toBe(1050);
	});

	it("stays correct even when server and client clocks disagree the other way", () => {
		const offset = computeClockOffsetMs(5000, 4900); // client clock behind
		expect(offset).toBe(-100);
		expect(computeStartMs(5000, offset)).toBe(4900);
	});
});

describe("computeElapsedMs", () => {
	it("is the plain difference once startMs is in the past", () => {
		expect(computeElapsedMs(10_000, 7_000)).toBe(3_000);
	});

	it("never goes negative when startMs is briefly ahead of now (clock skew)", () => {
		expect(computeElapsedMs(1_000, 1_500)).toBe(0);
	});
});

describe("formatElapsed", () => {
	it("renders whole and fractional seconds to one decimal place", () => {
		expect(formatElapsed(0)).toBe("0.0s");
		expect(formatElapsed(1_500)).toBe("1.5s");
		expect(formatElapsed(12_340)).toBe("12.3s");
	});
});

describe("shouldTick", () => {
	it("ticks only while running, connected, and a resolved start time exists", () => {
		expect(shouldTick({ running: true, connected: true, startMs: 1000 })).toBe(true);
	});

	it("does not tick when not running", () => {
		expect(shouldTick({ running: false, connected: true, startMs: 1000 })).toBe(false);
	});

	it("does not tick while disconnected — avoids a timer that free-runs past what the server actually reported", () => {
		expect(shouldTick({ running: true, connected: false, startMs: 1000 })).toBe(false);
	});

	it("does not tick before turnStartedAt has resolved to a start time", () => {
		expect(shouldTick({ running: true, connected: true, startMs: undefined })).toBe(false);
	});
});
