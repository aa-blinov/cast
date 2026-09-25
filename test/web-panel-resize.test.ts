import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useMemo: (fn: () => unknown) => fn(),
		useRef: () => ({ current: null }),
	}),
	{ virtual: true },
);

import { nextWidthForKey, perFrame } from "../src/server/public/use-panel-resize.js";

describe("perFrame", () => {
	let frames: Array<() => void>;

	beforeEach(() => {
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
		vi.stubGlobal("cancelAnimationFrame", (id: number) => {
			frames[id - 1] = () => {};
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("applies only the latest event once per frame", () => {
		const apply = vi.fn();
		const move = perFrame(apply);
		move({ clientX: 1 });
		move({ clientX: 2 });
		move({ clientX: 3 });
		expect(apply).not.toHaveBeenCalled();

		for (const f of frames) f();
		expect(apply).toHaveBeenCalledOnce();
		expect(apply).toHaveBeenCalledWith({ clientX: 3 });
	});

	it("flush lands a pending position immediately and cancels its frame", () => {
		const apply = vi.fn();
		const move = perFrame(apply);
		move({ clientX: 7 });
		move.flush();
		expect(apply).toHaveBeenCalledWith({ clientX: 7 });

		for (const f of frames) f();
		expect(apply).toHaveBeenCalledOnce();
	});

	it("flush is a no-op with nothing pending", () => {
		const apply = vi.fn();
		perFrame(apply).flush();
		expect(apply).not.toHaveBeenCalled();
	});
});

describe("nextWidthForKey", () => {
	const range = { min: 320, max: 800 };

	it("grows on the panel's grow key and shrinks on the other arrow", () => {
		expect(nextWidthForKey("ArrowLeft", false, 500, range, "ArrowLeft")).toBe(516);
		expect(nextWidthForKey("ArrowRight", false, 500, range, "ArrowLeft")).toBe(484);
		expect(nextWidthForKey("ArrowRight", false, 500, range, "ArrowRight")).toBe(516);
	});

	it("takes bigger steps with Shift and clamps to the range", () => {
		expect(nextWidthForKey("ArrowLeft", true, 500, range, "ArrowLeft")).toBe(564);
		expect(nextWidthForKey("ArrowLeft", true, 790, range, "ArrowLeft")).toBe(800);
		expect(nextWidthForKey("ArrowRight", true, 330, range, "ArrowLeft")).toBe(320);
	});

	it("jumps to the limits on Home and End and ignores other keys", () => {
		expect(nextWidthForKey("Home", false, 500, range, "ArrowLeft")).toBe(320);
		expect(nextWidthForKey("End", false, 500, range, "ArrowLeft")).toBe(800);
		expect(nextWidthForKey("a", false, 500, range, "ArrowLeft")).toBeNull();
	});
});
