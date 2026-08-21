import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/server/public/api.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubWindow(): ReturnType<typeof vi.fn> {
	const assign = vi.fn();
	vi.stubGlobal("window", { location: { origin: "http://cast.test", assign } });
	return assign;
}

describe("web api client", () => {
	it("builds a JSON request and returns its response", async () => {
		stubWindow();
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(api("POST", "/api/example", { value: 42 })).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://cast.test/api/example",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value: 42 }),
				cache: "no-store",
			}),
		);
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("redirects expired sessions to the login page", async () => {
		const assign = stubWindow();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

		await expect(api("GET", "/api/private")).resolves.toBeNull();
		expect(assign).toHaveBeenCalledWith("/login");
	});

	it("prefers the server error over the HTTP status", async () => {
		stubWindow();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Not allowed" }), { status: 403 })),
		);

		await expect(api("GET", "/api/private")).rejects.toThrow("Not allowed");
	});
});
