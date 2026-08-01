import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("preact/hooks", () => ({ useEffect: () => {}, useState: (value: unknown) => [value, vi.fn()] }), {
	virtual: true,
});
vi.mock("../src/web/public/api.js", () => ({ api: vi.fn() }));
vi.mock("../src/web/public/modal-focus.js", () => ({ useModalFocusTrap: () => null }));

import { ShareModal } from "../src/web/public/share-modal.js";

describe("ShareModal", () => {
	it("is exported as an isolated component", () => {
		expect(typeof ShareModal).toBe("function");
	});
});
