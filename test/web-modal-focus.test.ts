import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	nextContainer: null as unknown,
	cleanups: [] as Array<() => void>,
}));

vi.mock(
	"preact/hooks",
	() => ({
		// Run effects synchronously so a hook call mounts the trap in place.
		useEffect: (fn: () => (() => void) | undefined) => {
			const cleanup = fn();
			if (cleanup) hooks.cleanups.push(cleanup);
		},
		useRef: () => ({ current: hooks.nextContainer }),
	}),
	{ virtual: true },
);

import { FOCUSABLE_SELECTOR, pressable, rovingRows, useModalFocusTrap } from "../src/server/public/modal-focus.js";

type Listener = (e: unknown) => void;

class FakeElement {
	click = vi.fn();
	focus = vi.fn();
}

function fakeModal(closeSelectorMatches = true) {
	const closeBtn = new FakeElement();
	return {
		closeBtn,
		container: {
			focus: vi.fn(),
			querySelector: (sel: string) => (sel.includes(".modal-close") && closeSelectorMatches ? closeBtn : null),
			querySelectorAll: () => [],
		},
	};
}

function escapeEvent(overrides: Record<string, unknown> = {}) {
	return { key: "Escape", defaultPrevented: false, stopPropagation: vi.fn(), ...overrides };
}

describe("web modal focus module", () => {
	let listeners: Map<string, Set<Listener>>;

	beforeEach(() => {
		listeners = new Map();
		vi.stubGlobal("HTMLElement", FakeElement);
		vi.stubGlobal("document", {
			activeElement: null,
			addEventListener: (type: string, fn: Listener) => {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type)?.add(fn);
			},
			removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
		});
	});

	afterEach(() => {
		for (const cleanup of hooks.cleanups.splice(0).reverse()) cleanup();
		vi.unstubAllGlobals();
	});

	const pressEscape = (e = escapeEvent()) => {
		for (const fn of listeners.get("keydown") ?? []) fn(e);
		return e;
	};

	it("keeps disabled controls out of the focus cycle", () => {
		expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
		expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
	});

	it("closes only the topmost modal on Escape", () => {
		const below = fakeModal();
		const top = fakeModal();
		hooks.nextContainer = below.container;
		useModalFocusTrap(true);
		hooks.nextContainer = top.container;
		useModalFocusTrap(true);

		const e = pressEscape();

		expect(top.closeBtn.click).toHaveBeenCalledOnce();
		expect(below.closeBtn.click).not.toHaveBeenCalled();
		expect(e.stopPropagation).toHaveBeenCalled();
	});

	it("leaves Escape to a field inside the modal that already handled it", () => {
		const modal = fakeModal();
		hooks.nextContainer = modal.container;
		useModalFocusTrap(true);

		pressEscape(escapeEvent({ defaultPrevented: true }));

		expect(modal.closeBtn.click).not.toHaveBeenCalled();
	});

	it("lets Escape propagate when the modal has no dismiss control", () => {
		const modal = fakeModal(false);
		hooks.nextContainer = modal.container;
		useModalFocusTrap(true);

		const e = pressEscape();

		expect(e.stopPropagation).not.toHaveBeenCalled();
	});

	it("drops the document listener once the last modal closes", () => {
		hooks.nextContainer = fakeModal().container;
		useModalFocusTrap(true);
		for (const cleanup of hooks.cleanups.splice(0)) cleanup();

		expect(listeners.get("keydown")?.size ?? 0).toBe(0);
	});
});

describe("pressable", () => {
	const keyEvent = (key: string, fromChild = false) => {
		const row = {};
		return { key, currentTarget: row, target: fromChild ? {} : row, preventDefault: vi.fn() };
	};

	it("makes a row focusable and activates it with Enter and Space", () => {
		const onPress = vi.fn();
		const props = pressable(onPress);
		expect(props.role).toBe("button");
		expect(props.tabIndex).toBe(0);

		const enter = keyEvent("Enter");
		props.onKeyDown(enter);
		props.onKeyDown(keyEvent(" "));

		expect(onPress).toHaveBeenCalledTimes(2);
		expect(enter.preventDefault).toHaveBeenCalled();
	});

	it("ignores other keys and keys aimed at nested controls", () => {
		const onPress = vi.fn();
		const props = pressable(onPress);

		props.onKeyDown(keyEvent("a"));
		props.onKeyDown(keyEvent("Enter", true));

		expect(onPress).not.toHaveBeenCalled();
	});
});

describe("rovingRows ref", () => {
	it("makes the first row the only tab stop and keeps that true as rows are added", () => {
		let mutate: () => void = () => {};
		vi.stubGlobal(
			"MutationObserver",
			class {
				constructor(cb: () => void) {
					mutate = cb;
				}
				observe() {}
			},
		);
		const rows = [0, 1].map(() => ({ tabIndex: 0 }));
		const container = { querySelectorAll: () => rows };
		(rovingRows(".ref-row") as { ref: (el: unknown) => void }).ref(container);
		expect(rows.map((r) => r.tabIndex)).toEqual([0, -1]);
		rows.push({ tabIndex: 0 });
		mutate();
		expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
		vi.unstubAllGlobals();
	});
});

describe("rovingRows", () => {
	const makeList = () => {
		const rows = [0, 1, 2].map((i) => ({
			i,
			tabIndex: 0,
			focus: vi.fn(),
			matches: (selector: string) => selector === ".row",
		}));
		const container = { querySelectorAll: () => rows };
		return { rows, container };
	};
	const keydown = (container: unknown, target: unknown, key: string) => {
		const e = { target, currentTarget: container, key, preventDefault: vi.fn() };
		(rovingRows(".row") as { onKeyDown: (e: unknown) => void }).onKeyDown(e);
		return e;
	};

	it("makes the focused row the list's only tab stop", () => {
		const { rows, container } = makeList();
		(rovingRows(".row") as { onFocusCapture: (e: unknown) => void }).onFocusCapture({
			target: rows[1],
			currentTarget: container,
		});
		expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
	});

	it("moves focus with the arrows, Home and End, and stops at the ends", () => {
		const { rows, container } = makeList();
		keydown(container, rows[0], "ArrowDown");
		expect(rows[1].focus).toHaveBeenCalled();
		keydown(container, rows[0], "End");
		expect(rows[2].focus).toHaveBeenCalled();
		const atTop = keydown(container, rows[0], "ArrowUp");
		expect(atTop.preventDefault).not.toHaveBeenCalled();
		const other = keydown(container, rows[0], "a");
		expect(other.preventDefault).not.toHaveBeenCalled();
	});

	it("leaves keys alone when the target is not a row", () => {
		const { rows, container } = makeList();
		const input = { matches: () => false };
		const e = keydown(container, input, "ArrowDown");
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(rows.every((r) => r.focus.mock.calls.length === 0)).toBe(true);
	});
});
