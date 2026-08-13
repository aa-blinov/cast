import { describe, expect, it, vi } from "vitest";
import { api } from "../src/server/public/api.js";

describe("web API client", () => {
	it("bypasses browser caches for dynamic REST responses", async () => {
		vi.stubGlobal("window", { location: { origin: "http://cast.test" } });
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await api("GET", "/api/sessions/session-1/fs?path=.");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://cast.test/api/sessions/session-1/fs?path=.",
			expect.objectContaining({ cache: "no-store" }),
		);
		vi.unstubAllGlobals();
	});
});
