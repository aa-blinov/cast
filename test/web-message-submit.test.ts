import { describe, expect, it, vi } from "vitest";

vi.mock("../src/web/public/api.js", () => ({ api: vi.fn() }));

import { submitMessage } from "../src/web/public/message-submit.js";

describe("web message submission", () => {
	it("exports the extracted submit operation", () => {
		expect(submitMessage).toBeTypeOf("function");
	});
});
