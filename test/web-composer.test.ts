import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useRef: () => ({ current: null }),
		useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));

import { Composer, canSubmitAttachments } from "../src/server/public/composer.js";

describe("Composer", () => {
	it("is exported as the isolated composer component", () => {
		expect(typeof Composer).toBe("function");
	});

	it("blocks sending while an attachment is uploading or failed", () => {
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", uploading: true }])).toBe(false);
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", error: "Upload failed" }])).toBe(false);
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", path: "/tmp/large.zip" }])).toBe(true);
	});
});
