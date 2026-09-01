import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../src/core/settings.ts";

// fetchUrlLocal resolves every hostname it's given (SSRF guard) — mocked so
// these tests don't depend on real DNS/network, with a public IP by default
// and a per-test override for the DNS-rebinding scenario below.
const mockDnsLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
vi.mock("node:dns/promises", () => ({ lookup: (...args: unknown[]) => mockDnsLookup(...args) }));

import {
	execWebFetch,
	execWebSearch,
	fetchUrl,
	fetchUrlLocal,
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
	mockDnsLookup.mockReset();
	mockDnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
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

	it("rejects an invalid maxResults before making a request", async () => {
		const result = await execWebSearch({ query: "test", maxResults: 0 });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("maxResults");
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

	it("rejects a non-http(s) scheme before ever calling fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await execWebFetch({ url: "file:///etc/passwd" });

		expect(result.isError).toBe(true);
		expect(result.content).toContain("unsupported URL scheme");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still accepts plain http (not just https)", async () => {
		mockFetchOnce({ ok: true, status: 200, text: "Title: t\n\nMarkdown Content:\nbody" });
		const result = await execWebFetch({ url: "http://example.com/" });
		expect(result.isError).toBeUndefined();
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

	it("retries once on a 5xx and succeeds on the second attempt", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "" })
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					statusText: "",
					text: async () => "Title: t\n\nMarkdown Content:\nbody",
				});
			vi.stubGlobal("fetch", fetchMock);

			const promise = fetchUrl("https://example.com/");
			await vi.runAllTimersAsync();
			const result = await promise;

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(result.content).toBe("body");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry a 4xx — a second identical request won't fix a client error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", text: async () => "" });
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrl("https://example.com/")).rejects.toThrow("404");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted request even though a thrown error is otherwise retryable", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrl("https://example.com/")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("gives up after exhausting retries on a persistent 5xx", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi
				.fn()
				.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Error", text: async () => "" });
			vi.stubGlobal("fetch", fetchMock);

			const promise = fetchUrl("https://example.com/");
			const expectation = expect(promise).rejects.toThrow("500");
			await vi.runAllTimersAsync();
			await expectation;

			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("truncates at the last paragraph break within budget instead of mid-sentence", async () => {
		const para1 = "First paragraph. ".repeat(20); // well past the 70% cutoff on its own
		const para2 = "Second paragraph continues on and on. ".repeat(20);
		mockFetchOnce({ ok: true, status: 200, text: `Title: t\n\nMarkdown Content:\n${para1}\n\n${para2}` });

		const maxChars = para1.length + 20; // lands partway into para2
		const result = await fetchUrl("https://example.com/", { maxChars });

		expect(result.content).toBe(para1.trim());
		expect(result.content).not.toContain("Second paragraph");
	});

	it("falls back to a hard cut when no paragraph break exists near the budget", async () => {
		const body = "x".repeat(1000); // one giant paragraph, no "\n\n" anywhere
		mockFetchOnce({ ok: true, status: 200, text: `Title: t\n\nMarkdown Content:\n${body}` });

		const result = await fetchUrl("https://example.com/", { maxChars: 100 });

		expect(result.content).toHaveLength(100);
	});
});

// ============================================================================
// web_fetch — local backend (no Jina, direct fetch + HTML conversion)
// ============================================================================

function mockLocalResponse(opts: {
	ok?: boolean;
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	body: string;
}) {
	const headerMap = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	const bytes = new TextEncoder().encode(opts.body);
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		statusText: opts.statusText ?? "",
		headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
		arrayBuffer: async () => bytes.buffer,
	};
}

describe("fetchUrlLocal", () => {
	it("converts an HTML response to markdown by default", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockLocalResponse({
				headers: { "content-type": "text/html; charset=utf-8" },
				body: "<html><body><h1>Hello</h1><p>World <b>bold</b></p></body></html>",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/");

		expect(result.content).toContain("# Hello");
		expect(result.content).toContain("World **bold**");
	});

	it("drops the <head><title> text instead of duplicating it as stray prose before the real heading", async () => {
		// Regression: turndown has no special handling for <title> on its own,
		// so without excluding it explicitly its text gets rendered as a plain
		// line right before the page's real <h1>, restating the same words twice.
		const fetchMock = vi.fn().mockResolvedValue(
			mockLocalResponse({
				headers: { "content-type": "text/html" },
				body: "<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Body text.</p></body></html>",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const markdown = await fetchUrlLocal("https://example.com/", { format: "markdown" });
		expect(markdown.content).toBe("# Example Domain\n\nBody text.");

		const text = await fetchUrlLocal("https://example.com/", { format: "text" });
		expect(text.content).toBe("Example DomainBody text.");
	});

	it("extracts plain text and drops script/style content when format is 'text'", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockLocalResponse({
				headers: { "content-type": "text/html" },
				body: "<html><head><style>.x{color:red}</style></head><body><script>evil()</script><p>Visible text</p></body></html>",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/", { format: "text" });

		expect(result.content).toBe("Visible text");
		expect(result.content).not.toContain("evil()");
		expect(result.content).not.toContain("color:red");
	});

	it("returns raw markup unmodified when format is 'html'", async () => {
		const html = "<html><body><p>raw</p></body></html>";
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "text/html" }, body: html }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/", { format: "html" });

		expect(result.content).toBe(html);
	});

	it("does not attempt HTML conversion on a non-HTML content type", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "application/json" }, body: '{"a":1}' }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/data.json");

		expect(result.content).toBe('{"a":1}');
	});

	it("rejects an image content type instead of returning it as text", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "image/png" }, body: "binary-ish" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrlLocal("https://example.com/pic.png")).rejects.toThrow(/image/i);
	});

	it("allows SVG through — it's text (XML) underneath, unlike raster images", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "image/svg+xml" }, body: "<svg></svg>" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/pic.svg");
		expect(result.content).toBe("<svg></svg>");
	});

	it("rejects a non-textual, non-image binary content type", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				mockLocalResponse({ headers: { "content-type": "application/octet-stream" }, body: "\x00\x01" }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrlLocal("https://example.com/file.bin")).rejects.toThrow(/Unsupported/i);
	});

	it("rejects up front on a Content-Length header over the 5MB limit, without reading the body", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockLocalResponse({
				headers: { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) },
				body: "irrelevant",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrlLocal("https://example.com/huge")).rejects.toThrow(/too large/i);
	});

	it("rejects on actual body size even if Content-Length was absent or understated", async () => {
		const bigBody = "x".repeat(6 * 1024 * 1024);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "text/plain" }, body: bigBody }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrlLocal("https://example.com/huge")).rejects.toThrow(/too large/i);
	});

	it("retries once with a plain User-Agent on a Cloudflare bot challenge (403 + cf-mitigated)", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				mockLocalResponse({
					ok: false,
					status: 403,
					headers: { "cf-mitigated": "challenge" },
					body: "",
				}),
			)
			.mockResolvedValueOnce(mockLocalResponse({ headers: { "content-type": "text/plain" }, body: "got through" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/");

		expect(result.content).toBe("got through");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondCallHeaders = fetchMock.mock.calls[1][1].headers;
		expect(secondCallHeaders["User-Agent"]).toBe("cast");
	});

	it("does not retry a 403 that isn't a Cloudflare challenge", async () => {
		const fetchMock = vi.fn().mockResolvedValue(mockLocalResponse({ ok: false, status: 403, body: "" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchUrlLocal("https://example.com/")).rejects.toThrow("403");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("has no title — a raw HTTP response has no metadata block to extract one from", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "text/plain" }, body: "content" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchUrlLocal("https://example.com/");
		expect(result.title).toBe("");
	});

	describe("SSRF guard", () => {
		it("refuses a literal loopback address before ever calling fetch", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(fetchUrlLocal("http://127.0.0.1:1337/api/sessions")).rejects.toThrow(/private\/internal/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("refuses the cloud metadata link-local address", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(fetchUrlLocal("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private\/internal/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("refuses RFC1918 private ranges and IPv6 loopback/unique-local", async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			for (const url of [
				"http://10.0.0.5/",
				"http://172.16.0.1/",
				"http://192.168.1.1/",
				"http://[::1]/",
				"http://[fc00::1]/",
			]) {
				await expect(fetchUrlLocal(url)).rejects.toThrow(/private\/internal/i);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("allows a literal public IP straight through", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(mockLocalResponse({ headers: { "content-type": "text/plain" }, body: "ok" }));
			vi.stubGlobal("fetch", fetchMock);

			const result = await fetchUrlLocal("http://93.184.216.34/");
			expect(result.content).toBe("ok");
		});

		it("refuses a hostname that resolves (DNS rebinding) to a private address", async () => {
			mockDnsLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(fetchUrlLocal("https://rebind.example.com/")).rejects.toThrow(/private\/internal/i);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("re-validates a redirect target instead of blindly following it into a private address", async () => {
			const fetchMock = vi.fn().mockResolvedValueOnce(
				mockLocalResponse({
					ok: false,
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data/" },
					body: "",
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			await expect(fetchUrlLocal("https://example.com/redirects-away")).rejects.toThrow(/private\/internal/i);
			// The redirect response itself is fine to receive — only the second
			// hop (the actual internal address) must never be requested.
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("gives up after too many redirect hops instead of looping forever", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				mockLocalResponse({
					ok: false,
					status: 302,
					headers: { location: "https://example.com/next" },
					body: "",
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			await expect(fetchUrlLocal("https://example.com/loop")).rejects.toThrow(/too many redirects/i);
		});
	});
});

describe("execWebFetch — provider dispatch", () => {
	it("uses Jina by default (webFetchProvider unset)", async () => {
		mockFetchOnce({ ok: true, status: 200, text: "Title: t\n\nMarkdown Content:\nvia jina" });
		const result = await execWebFetch({ url: "https://example.com/" });
		expect(result.content).toContain("via jina");
		// Jina always goes through r.jina.ai — confirms the jina path (not local) ran.
		expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toContain("r.jina.ai");
	});

	it("uses the local backend once /web-fetch-provider is switched to 'local'", async () => {
		updateSettings({ webFetchProvider: "local" });
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				mockLocalResponse({ headers: { "content-type": "text/html" }, body: "<p>local content</p>" }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await execWebFetch({ url: "https://example.com/" });

		expect(result.content).toContain("local content");
		expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/");
	});

	it("passes the format arg through to the local backend", async () => {
		updateSettings({ webFetchProvider: "local" });
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				mockLocalResponse({ headers: { "content-type": "text/html" }, body: "<p>plain text please</p>" }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const result = await execWebFetch({ url: "https://example.com/", format: "text" });

		expect(result.content).toBe("plain text please");
	});
});
