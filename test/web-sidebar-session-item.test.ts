import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { SidebarSessionItem } from "../src/server/public/sidebar-session-item.js";

describe("SidebarSessionItem", () => {
	it("is exported as an isolated component", () => {
		expect(typeof SidebarSessionItem).toBe("function");
	});
});
