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

import {
	atTokenAt,
	Composer,
	canSubmitAttachments,
	imageNotice,
	voiceErrorMessage,
} from "../src/server/public/composer.js";

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

describe("voiceErrorMessage", () => {
	it("tells denied, missing and busy microphones apart", () => {
		expect(voiceErrorMessage({ name: "NotFoundError" })).toBe("No microphone found");
		expect(voiceErrorMessage({ name: "NotAllowedError" })).toBe("Microphone access was denied");
		expect(voiceErrorMessage({ name: "NotReadableError" })).toBe("The microphone is in use by another app");
		expect(voiceErrorMessage({ name: "Other" })).toBe("Could not start recording");
	});
});

describe("imageNotice", () => {
	it("says how many images were left out and which could not be read", () => {
		expect(imageNotice(0, 6, [])).toBe("");
		expect(imageNotice(1, 6, [])).toBe("1 image left out: up to 6 per message");
		expect(imageNotice(3, 6, [])).toBe("3 images left out: up to 6 per message");
		expect(imageNotice(0, 6, ["a.png", "b.png"])).toBe("Couldn't read a.png, b.png");
		expect(imageNotice(2, 6, ["a.png"])).toBe("2 images left out: up to 6 per message. Couldn't read a.png");
	});
});
