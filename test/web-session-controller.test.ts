import { describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({ useCallback: (fn: unknown) => fn }), { virtual: true });
vi.mock("../src/web/public/api.js", () => ({ api: vi.fn() }));

import { useSessionController } from "../src/web/public/use-session-controller.js";

describe("web session controller", () => {
	it("exports the session lifecycle hook", () => {
		expect(useSessionController).toBeTypeOf("function");
	});
});
