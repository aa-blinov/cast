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

import { atTokenAt, Composer, canSubmitAttachments } from "../src/server/public/composer.js";

describe("Composer", () => {
	it("is exported as the isolated composer component", () => {
		expect(typeof Composer).toBe("function");
	});

	it("blocks sending while an attachment is uploading or failed", () => {
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", uploading: true }])).toBe(false);
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", error: "Upload failed" }])).toBe(false);
		expect(canSubmitAttachments([{ id: "zip", name: "large.zip", path: "/tmp/large.zip" }])).toBe(true);
	});

	it("opens the @ file picker only on a word-initial @ at the caret, like the TUI", () => {
		expect(atTokenAt("look at @src/co", 15)).toEqual({ from: 8, to: 15, query: "src/co" });
		expect(atTokenAt("@", 1)).toEqual({ from: 0, to: 1, query: "" });
		expect(atTokenAt("mail a@b.com", 12)).toBeNull();
		expect(atTokenAt("@done next", 10)).toBeNull();
	});
});
