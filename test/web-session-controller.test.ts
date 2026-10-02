import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({ useCallback: (fn: unknown) => fn }), { virtual: true });
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));

import {
	readOlderPages,
	rememberOlderPages,
	useSessionController,
} from "../src/server/public/use-session-controller.js";

describe("web session controller", () => {
	it("exports the session lifecycle hook", () => {
		expect(useSessionController).toBeTypeOf("function");
	});
	describe("scroll-up page cache", () => {
		function entry(label: string) {
			return { anchorVersion: 1, messages: [{ role: "user", content: label }], oldestSeq: 0, hasMore: false };
		}

		it("keeps only the few most recently used sessions", () => {
			// An unbounded cache meant a tab left open for days held the
			// scroll-up history of every session ever visited — thousands of
			// messages each, for the life of the tab.
			const ref = { current: new Map() };
			for (const id of ["a", "b", "c", "d"]) rememberOlderPages(ref, id, entry(id));

			expect([...ref.current.keys()]).toEqual(["b", "c", "d"]);
			expect(readOlderPages(ref, "a")).toBeUndefined();
			expect(readOlderPages(ref, "d")).toEqual(entry("d"));
		});

		it("evicts by last use, not by insertion", () => {
			const ref = { current: new Map() };
			for (const id of ["a", "b", "c"]) rememberOlderPages(ref, id, entry(id));
			// Touching "a" makes it the newest, so "b" is the one to go.
			readOlderPages(ref, "a");
			rememberOlderPages(ref, "d", entry("d"));

			expect([...ref.current.keys()]).toEqual(["c", "a", "d"]);
			expect(readOlderPages(ref, "b")).toBeUndefined();
		});

		it("re-storing a session that's already cached doesn't evict anyone", () => {
			const ref = { current: new Map() };
			for (const id of ["a", "b", "c"]) rememberOlderPages(ref, id, entry(id));
			rememberOlderPages(ref, "a", entry("a2"));

			expect(ref.current.size).toBe(3);
			expect(readOlderPages(ref, "a")).toEqual(entry("a2"));
		});
	});
});

describe("useSessionController wiring", () => {
	it("is given every parameter it destructures", () => {
		// A missing one is just undefined, and the call that needs it throws inside a promise chain whose catch is empty:
		// the saved theme was never marked as current in settings for exactly that reason.
		const dir = join(import.meta.dirname, "../src/server/public");
		const controller = readFileSync(join(dir, "use-session-controller.js"), "utf8");
		const app = readFileSync(join(dir, "app.js"), "utf8");
		const wanted = /export function useSessionController\(\{([\s\S]*?)\}\)/
			.exec(controller)![1]!
			.split(",")
			.map((part) => part.trim().split(":")[0]!.trim())
			.filter(Boolean);
		const start = app.indexOf("useSessionController({");
		const call = app.slice(start, app.indexOf("});", start));
		const passed = new Set([...call.matchAll(/^\s*(\w+)\s*[,:]/gm)].map((m) => m[1]));
		expect(wanted.filter((name) => !passed.has(name))).toEqual([]);
	});
});
