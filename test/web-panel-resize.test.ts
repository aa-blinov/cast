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

import { perFrame } from "../src/server/public/use-panel-resize.js";

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
