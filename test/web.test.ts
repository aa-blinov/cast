import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../src/core/settings.ts";
import {
	execWebFetch,
	execWebSearch,
	fetchUrl,
	searchBrave,
	searchDuckDuckGo,
	searchTavily,
} from "../src/core/tools/web.ts";

function ddgHtml(results: { title: string; href: string; snippet: string }[]): string {
	return results
		.map(
			(r) =>
				`<div class="result results_links results_links_deep web-result">` +
				`<a class="result__a" href="${r.href}">${r.title}</a>` +
				`<a class="result__snippet">${r.snippet}</a>` +
				`</div>`,
		)
		.join("\n");
}

function mockFetchOnce(response: { ok: boolean; status: number; statusText?: string; text: string }): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: response.ok,
			status: response.status,
			statusText: response.statusText ?? "",
			text: async () => response.text,
		}),
	);
}

let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "cast-web-test-"));
	process.env.HOME = fakeHome;
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

// ============================================================================
// web_search
// ============================================================================

describe("execWebSearch", () => {
	it("requires a query", async () => {
		const result = await execWebSearch({});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("query");
	});

	it("uses DDG by default when no searchProvider is configured", async () => {
		const html = ddgHtml([{ title: "Default", href: "https://default.example/", snippet: "s" }]);
		mockFetchOnce({ ok: true, status: 200, text: html });

		const result = await execWebSearch({ query: "unique query default-provider" });

		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("Default");
		expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toContain("duckduckgo.com");
	});

	it("routes to Tavily when searchProvider is 'tavily' and a key is configured", async () => {
		updateSettings({ searchProvider: "tavily", tavilyApiKey: "tvly-test-key" });
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					results: [{ title: "Tavily Result", url: "https://tavily.example/", content: "tavily snippet" }],
				}),
			}),
		);

		const result = await execWebSearch({ query: "unique query tavily-routing" });

		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("Tavily Result");
		const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(call[0]).toBe("https://api.tavily.com/search");
	});

	it("errors clearly when searchProvider is 'tavily' but no API key is configured", async () => {
		updateSettings({ searchProvider: "tavily" });

		const result = await execWebSearch({ query: "unique query tavily-no-key" });

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Tavily");
		expect(result.content).toContain("/web-search-provider");
	});

	it("routes to Brave when searchProvider is 'brave' and a key is configured", async () => {
		updateSettings({ searchProvider: "brave", braveApiKey: "brave-test-key" });
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					web: {
						results: [{ title: "Brave Result", url: "https://brave.example/", description: "brave snippet" }],
					},
				}),
			}),
		);

		const result = await execWebSearch({ query: "unique query brave-routing" });

		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("Brave Result");
		const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		expect(String(call[0])).toContain("api.search.brave.com");
	});

	it("errors clearly when searchProvider is 'brave' but no API key is configured", async () => {
		updateSettings({ searchProvider: "brave" });

		const result = await execWebSearch({ query: "unique query brave-no-key" });

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Brave");
		expect(result.content).toContain("/web-search-provider");
	});
});

describe("searchDuckDuckGo", () => {
	it("parses titles, decoded URLs, and snippets from the DDG HTML endpoint", async () => {
		const html = ddgHtml([
			{
				title: "Example Title",
				href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
				snippet: "Example snippet text.",
			},
			{ title: "Another Title", href: "https://another.com/", snippet: "Another snippet." },
		]);
		mockFetchOnce({ ok: true, status: 200, text: html });

		const { results } = await searchDuckDuckGo("unique query one");

		expect(results).toEqual([
			{ title: "Example Title", url: "https://example.com/page", snippet: "Example snippet text." },
			{ title: "Another Title", url: "https://another.com/", snippet: "Another snippet." },
		]);
	});

	it("throws a clear error when DDG returns a rate-limit challenge (status 202)", async () => {
		mockFetchOnce({ ok: false, status: 202, text: "" });

		await expect(searchDuckDuckGo("unique query two")).rejects.toThrow(/rate limit/i);
	});

	it("caches results so a repeated query doesn't hit DDG again", async () => {
		const html = ddgHtml([{ title: "Cached", href: "https://cached.example/", snippet: "s" }]);
		mockFetchOnce({ ok: true, status: 200, text: html });

		await searchDuckDuckGo("unique query three");
		await searchDuckDuckGo("unique query three");

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("a later call with a larger maxResults isn't capped by an earlier call's smaller maxResults on cache hit", async () => {
		// The cache key doesn't include maxResults. A first call for maxResults:2
		// used to cache only the 2 parsed results, so a later call for the same
		// query with maxResults:10 would silently get stuck at 2 for the rest of
		// the TTL instead of the 5 actually available on the page.
		const html = ddgHtml(
			Array.from({ length: 5 }, (_, i) => ({
				title: `Result ${i}`,
				href: `https://example.com/${i}`,
				snippet: "s",
			})),
		);
		mockFetchOnce({ ok: true, status: 200, text: html });

		const first = await searchDuckDuckGo("unique query cache-cap", { maxResults: 2 });
		expect(first.results).toHaveLength(2);

		const second = await searchDuckDuckGo("unique query cache-cap", { maxResults: 10 });
		expect(second.results).toHaveLength(5);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

function mockFetchJsonOnce(response: { ok: boolean; status: number; json: unknown }): void {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: response.ok,
			status: response.status,
			json: async () => response.json,
		}),
	);
}

describe("searchTavily", () => {
	it("parses title, url, and content into title/url/snippet", async () => {
		mockFetchJsonOnce({
			ok: true,
			status: 200,
			json: { results: [{ title: "Tavily Title", url: "https://tavily.example/page", content: "Tavily content." }] },
		});

		const { results } = await searchTavily("unique tavily query one", "tvly-key");

		expect(results).toEqual([
			{ title: "Tavily Title", url: "https://tavily.example/page", snippet: "Tavily content." },
		]);
	});

	it("sends the API key as a Bearer token", async () => {
		mockFetchJsonOnce({ ok: true, status: 200, json: { results: [] } });

		await searchTavily("unique tavily query auth", "tvly-secret");

		const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		const init = call[1] as { headers: Record<string, string> };
		expect(init.headers.Authorization).toBe("Bearer tvly-secret");
	});

	it("throws a clear error on an invalid API key (401/403)", async () => {
		mockFetchJsonOnce({ ok: false, status: 401, json: {} });

		await expect(searchTavily("unique tavily query two", "bad-key")).rejects.toThrow(/api key/i);
	});

	it("throws a clear error when Tavily's own rate limit/quota is hit (429)", async () => {
		mockFetchJsonOnce({ ok: false, status: 429, json: {} });

		await expect(searchTavily("unique tavily query three", "tvly-key")).rejects.toThrow(/rate limit|quota/i);
	});

	it("caches results so a repeated query doesn't hit Tavily again", async () => {
		mockFetchJsonOnce({
			ok: true,
			status: 200,
			json: { results: [{ title: "Cached", url: "https://cached.example/", content: "s" }] },
		});

		await searchTavily("unique tavily query cache", "tvly-key");
		await searchTavily("unique tavily query cache", "tvly-key");

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty query before making a request", async () => {
		vi.stubGlobal("fetch", vi.fn());

		await expect(searchTavily("   ", "tvly-key")).rejects.toThrow(/empty/i);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("truncates a query over Tavily's undocumented 400-char limit instead of failing", async () => {
		mockFetchJsonOnce({ ok: true, status: 200, json: { results: [] } });
		const longQuery = "a".repeat(500);

		const { query } = await searchTavily(longQuery, "tvly-key");

		expect(query.length).toBe(400);
		const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		const body = JSON.parse((call[1] as { body: string }).body);
		expect(body.query.length).toBe(400);
	});

	it("surfaces Tavily's own error detail on a 400 instead of a bare status code", async () => {
		mockFetchJsonOnce({ ok: false, status: 400, json: { detail: { error: "Something specific broke." } } });

		await expect(searchTavily("unique tavily query detail", "tvly-key")).rejects.toThrow(/Something specific broke/);
	});
});

describe("searchBrave", () => {
	it("parses title, url, and description into title/url/snippet, decoding HTML entities", async () => {
		mockFetchJsonOnce({
			ok: true,
			status: 200,
			json: {
				web: {
					results: [
						{ title: "Brave Title", url: "https://brave.example/page", description: "It&#x27;s content." },
					],
				},
			},
		});

		const { results } = await searchBrave("unique brave query one", "brave-key");

		expect(results).toEqual([{ title: "Brave Title", url: "https://brave.example/page", snippet: "It's content." }]);
	});

	it("sends the API key via the X-Subscription-Token header", async () => {
		mockFetchJsonOnce({ ok: true, status: 200, json: { web: { results: [] } } });

		await searchBrave("unique brave query auth", "brave-secret");

		const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
		const init = call[1] as { headers: Record<string, string> };
		expect(init.headers["X-Subscription-Token"]).toBe("brave-secret");
	});

	it("rejects an empty query before making a request", async () => {
		vi.stubGlobal("fetch", vi.fn());

		await expect(searchBrave("   ", "brave-key")).rejects.toThrow(/empty/i);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("throws a clear error on an invalid API key (422 SUBSCRIPTION_TOKEN_INVALID)", async () => {
		mockFetchJsonOnce({
			ok: false,
			status: 422,
			json: { error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid." } },
		});

		await expect(searchBrave("unique brave query two", "bad-key")).rejects.toThrow(/api key/i);
	});

	it("throws a clear error when Brave's own rate limit/quota is hit (429)", async () => {
		mockFetchJsonOnce({ ok: false, status: 429, json: {} });

		await expect(searchBrave("unique brave query three", "brave-key")).rejects.toThrow(/rate limit|quota/i);
	});

	it("surfaces Brave's own error detail on an unrecognized 4xx instead of a bare status code", async () => {
		mockFetchJsonOnce({ ok: false, status: 400, json: { error: { detail: "Something specific broke." } } });

		await expect(searchBrave("unique brave query detail", "brave-key")).rejects.toThrow(/Something specific broke/);
	});

	it("caches results so a repeated query doesn't hit Brave again", async () => {
		mockFetchJsonOnce({
			ok: true,
			status: 200,
			json: { web: { results: [{ title: "Cached", url: "https://cached.example/", description: "s" }] } },
		});

		await searchBrave("unique brave query cache", "brave-key");
		await searchBrave("unique brave query cache", "brave-key");

		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// web_fetch
// ============================================================================

describe("execWebFetch", () => {
	it("requires a url", async () => {
		const result = await execWebFetch({});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("url");
	});

	it("rejects an invalid url", async () => {
		const result = await execWebFetch({ url: "not-a-url" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("invalid URL");
	});
});

describe("fetchUrl", () => {
	it("extracts the title and strips the metadata preamble from Jina Reader's response", async () => {
		// Real r.jina.ai response shape: a metadata block ("Title:", "URL Source:",
		// optional "Warning:") followed by "Markdown Content:" and the actual body —
		// not a bare markdown document starting with a top-level heading.
		const jinaResponse =
			"Title: Example Domain\n\n" +
			"URL Source: https://example.com/\n\n" +
			"Published Time: Wed, 01 Jul 2026 17:50:18 GMT\n\n" +
			"Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.\n\n" +
			"Markdown Content:\n" +
			"# Example Domain\n\n" +
			"This domain is for use in documentation examples without needing permission.\n";
		mockFetchOnce({ ok: true, status: 200, text: jinaResponse });

		const result = await fetchUrl("https://example.com/");

		expect(result.title).toBe("Example Domain");
		expect(result.content).toBe(
			"# Example Domain\n\nThis domain is for use in documentation examples without needing permission.",
		);
		expect(result.content).not.toContain("URL Source:");
		expect(result.content).not.toContain("Warning:");
	});

	it("rejects immediately when given a signal that was already aborted before the call", async () => {
		// An AbortSignal's 'abort' event fires once, at the moment abort() is
		// called. A signal aborted before fetchUrl runs (Esc pressed, or the
		// turn already ended) has already fired that event — a listener added
		// now would never see it, so the fetch used to run to completion
		// unaborted instead of being cancelled.
		//
		// mockFetchOnce ignores the signal it's given entirely, so it can't
		// catch this — it would "pass" whether or not fetchUrl actually wires
		// the abort through. This mock instead reproduces the real Fetch API
		// contract that matters here: reject immediately if the signal passed
		// to it is already aborted, exactly like undici/native fetch does.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
				if (init?.signal?.aborted)
					return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
				return Promise.resolve({ ok: true, status: 200, statusText: "", text: async () => "" });
			}),
		);
		const controller = new AbortController();
		controller.abort();

		await expect(fetchUrl("https://example.com/", { signal: controller.signal })).rejects.toThrow();
	});

	it("removes its abort listener from an externally-supplied signal once the request settles", async () => {
		mockFetchOnce({ ok: true, status: 200, text: "Title: t\n\nMarkdown Content:\nbody" });
		const controller = new AbortController();

		await fetchUrl("https://example.com/", { signal: controller.signal });

		// The signal is long-lived and shared across every tool call in a session
		// (see loop.ts) — a listener left behind here would leak on every fetch.
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
