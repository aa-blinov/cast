import { describe, expect, it, vi } from "vitest";

vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));

import { submitMessage } from "../src/server/public/message-submit.js";

describe("web message submission", () => {
	it("exports the extracted submit operation", () => {
		expect(submitMessage).toBeTypeOf("function");
	});
});
