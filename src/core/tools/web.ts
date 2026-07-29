/**
 * Web tools — DDG search (html.duckduckgo.com scraper) or Tavily/Brave (API), + Jina Reader (fetch).
 *
 * DDG search scrapes the HTML lite endpoint — no JS challenge, no VQD,
 * no Python dependency. Returns title + URL + snippet per result.
 * DDG rate-limits after ~4 requests per IP — cached results don't count
 * toward the limit, so repeated queries are free. Tavily and Brave
 * (settings.searchProvider, needs tavilyApiKey/braveApiKey respectively) are
 * opt-in alternatives for anyone hitting that cap: Tavily is an AI-search
 * aggregator with a recurring 1000 requests/month free tier; Brave is an
 * actual general web index, a more direct DDG replacement.
 *
 * Web fetch uses Jina Reader (`r.jina.ai`) — free, no API key, returns
 * clean markdown optimized for LLM consumption.
 */

import { loadSettings } from "../settings.ts";
import type { ToolResult } from "./shared.ts";

// ============================================================================
// Constants
// ============================================================================

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 10;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 100;
// One retry for a transient failure (connection reset, Jina briefly 5xx-ing)
// — not more, so a genuinely dead endpoint still fails in one extra round
// trip's time instead of tripling the caller's wait.
const FETCH_MAX_ATTEMPTS = 2;
const FETCH_RETRY_DELAY_MS = 500;
// How many results a single DDG page fetch parses, independent of any one
// caller's `maxResults`. The cache key doesn't include maxResults, so a
// query first run with a small maxResults must not permanently cap what a
// later call for the same query (with a larger maxResults) can get out of
// the cache for the rest of the TTL — parse the full page once and truncate
// per-caller on the way out instead.
const PARSE_RESULTS_LIMIT = 25;

// ============================================================================
// DDG Search — html.duckduckgo.com
// ============================================================================

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearchResults {
	query: string;
	results: SearchResult[];
}

/** In-memory search cache — avoids wasting DDG's ~4 request budget on repeats. */
const searchCache = new Map<string, { results: SearchResults; ts: number }>();

function cacheKey(provider: string, query: string, region?: string, time?: string): string {
	return `${provider}\0${query}\0${region ?? ""}\0${time ?? ""}`;
}

function cacheGet(key: string): SearchResults | null {
	const entry = searchCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > CACHE_TTL_MS) {
		searchCache.delete(key);
		return null;
	}
	return entry.results;
}

function cacheSet(key: string, results: SearchResults): void {
	if (searchCache.size >= CACHE_MAX_ENTRIES) {
		// Evict oldest entry
		const first = searchCache.keys().next().value;
		if (first !== undefined) searchCache.delete(first);
	}
	searchCache.set(key, { results, ts: Date.now() });
}

/** Decode DDG redirect URL: `//duckduckgo.com/l/?uddg=https%3A%2F%2F...` → `https://...` */
function decodeDdgUrl(href: string): string {
	try {
		const uddg = /uddg=([^&"]+)/.exec(href);
		if (uddg) return decodeURIComponent(uddg[1]);
		if (href.startsWith("http")) return href;
		return "";
	} catch {
		return "";
	}
}

/** Strip HTML tags and decode common entities. */
function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#\d+;/g, (m) => {
			const code = Number.parseInt(m.slice(2, -1), 10);
			return Number.isNaN(code) ? m : String.fromCodePoint(code);
		})
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Search DuckDuckGo via the HTML lite endpoint.
 * No API key, no JS challenge, no Python. Pure fetch + regex.
 *
 * DDG rate-limits to ~4 requests per IP. Cached results are returned
 * instantly without hitting DDG. When rate-limited, returns a clear error
 * instead of empty results.
 */
export async function searchDuckDuckGo(
	query: string,
	options?: {
		maxResults?: number;
		region?: string;
		time?: string;
		signal?: AbortSignal;
	},
): Promise<SearchResults> {
	const maxResults = options?.maxResults ?? MAX_SEARCH_RESULTS;
	const signal = options?.signal;

	// Check cache first
	const key = cacheKey("ddg", query, options?.region, options?.time);
	const cached = cacheGet(key);
	if (cached) return { ...cached, results: cached.results.slice(0, maxResults) };

	const params = new URLSearchParams({ q: query });
	if (options?.region) params.set("kl", options.region);
	if (options?.time) params.set("df", options.time);
	const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
	const resp = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "text/html",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal,
	});

	if (resp.status === 202) {
		throw new Error(
			"DDG rate limit — CAPTCHA triggered. Too many searches from this IP. " +
				"Try again later or use a different search provider.",
		);
	}
	if (!resp.ok) throw new Error(`DDG HTTP ${resp.status}`);

	const html = await resp.text();

	// Detect CAPTCHA page (sometimes returned as 200)
	if (html.includes("Please complete the following challenge")) {
		throw new Error("DDG rate limit — CAPTCHA triggered. Try again later.");
	}

	// Parse results
	const blocks = html.split(/<div[^>]+class="result\s/);
	const results: SearchResult[] = [];

	for (let i = 1; i < blocks.length && results.length < PARSE_RESULTS_LIMIT; i++) {
		const block = blocks[i];

		const titleMatch = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!titleMatch) continue;

		const resultUrl = decodeDdgUrl(titleMatch[1]);
		if (!resultUrl) continue;
		const title = stripTags(titleMatch[2]);
		if (!title) continue;

		const snippetMatch = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";

		results.push({ title, url: resultUrl, snippet });
	}

	const searchResults = { query, results };

	// Cache the full parsed set (see PARSE_RESULTS_LIMIT) even when empty, to
	// avoid re-hitting DDG; truncate to this caller's maxResults on the way out.
	cacheSet(key, searchResults);

	return { ...searchResults, results: results.slice(0, maxResults) };
}

// ============================================================================
// Tavily Search — api.tavily.com
// ============================================================================

/**
 * Search via the Tavily Search API (https://docs.tavily.com). Needs an API
 * key (https://app.tavily.com) — the free tier is 1000 requests/month, a
 * recurring monthly allowance rather than DDG's hard ~4-requests-per-IP cap.
 */
// Confirmed empirically against the live API (undocumented): a query over
// this length gets a flat 400, with no partial/best-effort behavior.
const TAVILY_MAX_QUERY_CHARS = 400;

export async function searchTavily(
	query: string,
	apiKey: string,
	options?: {
		maxResults?: number;
		signal?: AbortSignal;
	},
): Promise<SearchResults> {
	if (!query.trim()) throw new Error("Tavily search error: query is empty.");

	// Truncate rather than fail — an agent-generated query that runs long is
	// still a valid search intent; cutting it to the API's actual limit keeps
	// the call working instead of erroring on something the caller can't see.
	const truncatedQuery = query.length > TAVILY_MAX_QUERY_CHARS ? query.slice(0, TAVILY_MAX_QUERY_CHARS) : query;

	const maxResults = Math.min(options?.maxResults ?? MAX_SEARCH_RESULTS, 20); // Tavily caps at 20
	const signal = options?.signal;

	const key = cacheKey("tavily", truncatedQuery);
	const cached = cacheGet(key);
	if (cached) return { ...cached, results: cached.results.slice(0, maxResults) };

	const resp = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		// Always request Tavily's own max (20), independent of this caller's
		// maxResults — same reasoning as DDG's PARSE_RESULTS_LIMIT: cache the
		// full set once, slice per-caller below, so a query first run with a
		// small maxResults doesn't cap what a later, larger request can get
		// out of the cache for the rest of the TTL.
		body: JSON.stringify({ query: truncatedQuery, max_results: 20 }),
		signal,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new Error("Tavily rejected the API key — check /web-search-provider or the tavilyApiKey setting.");
	}
	if (resp.status === 429) {
		throw new Error("Tavily rate limit or free-tier quota exceeded for this month.");
	}
	if (!resp.ok) {
		// Tavily returns a JSON body describing the actual problem
		// (e.g. `{"detail":{"error":"..."}}`) — surface it instead of a bare
		// status code whenever it parses.
		const detail = await resp
			.json()
			.then((body: unknown) => {
				const err = (body as { detail?: { error?: string } } | undefined)?.detail?.error;
				return err ? `: ${err}` : "";
			})
			.catch(() => "");
		throw new Error(`Tavily HTTP ${resp.status}${detail}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};

	const results: SearchResult[] = (data.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));

	const searchResults = { query: truncatedQuery, results };
	cacheSet(key, searchResults);

	return { ...searchResults, results: results.slice(0, maxResults) };
}

// ============================================================================
// Brave Search — api.search.brave.com
// ============================================================================

/**
 * Search via the Brave Search API (https://api-dashboard.search.brave.com).
 * Needs an API key. Unlike Tavily (an AI-search aggregator), this is Brave's
 * own general web index — a straightforward SERP alternative to DDG.
 */
export async function searchBrave(
	query: string,
	apiKey: string,
	options?: {
		maxResults?: number;
		signal?: AbortSignal;
	},
): Promise<SearchResults> {
	if (!query.trim()) throw new Error("Brave search error: query is empty.");

	const maxResults = Math.min(options?.maxResults ?? MAX_SEARCH_RESULTS, 20); // Brave caps count at 20
	const signal = options?.signal;

	const key = cacheKey("brave", query);
	const cached = cacheGet(key);
	if (cached) return { ...cached, results: cached.results.slice(0, maxResults) };

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	// Always request Brave's own max (20) — same cache-the-full-set-once
	// reasoning as Tavily/DDG above.
	url.searchParams.set("count", "20");

	const resp = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
		signal,
	});

	if (resp.status === 429) {
		throw new Error("Brave rate limit or free-tier quota exceeded.");
	}
	if (!resp.ok) {
		// Brave returns 422 for both an invalid key and a bad request, with a
		// JSON body naming the actual problem — surface it instead of a bare
		// status code. Recognize the invalid-key case specifically since it's
		// the one a user is most likely to hit and can fix themselves.
		const body = await resp
			.json()
			.catch(() => undefined as { error?: { code?: string; detail?: string } } | undefined);
		if (body?.error?.code === "SUBSCRIPTION_TOKEN_INVALID") {
			throw new Error("Brave rejected the API key — check /web-search-provider or the braveApiKey setting.");
		}
		const detail = body?.error?.detail ? `: ${body.error.detail}` : "";
		throw new Error(`Brave HTTP ${resp.status}${detail}`);
	}

	const data = (await resp.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
	};

	const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
		title: stripTags(r.title ?? ""),
		url: r.url ?? "",
		snippet: stripTags(r.description ?? ""),
	}));

	const searchResults = { query, results };
	cacheSet(key, searchResults);

	return { ...searchResults, results: results.slice(0, maxResults) };
}

// ============================================================================
// Web Fetch — Jina Reader API
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP status worth retrying once — transient server-side trouble, not a
 *  client error (4xx) that a second identical request won't fix. */
function isRetryableStatus(status: number): boolean {
	return status >= 500;
}

/** A thrown fetch failure worth retrying once — connection-level trouble
 *  (reset, DNS hiccup), never an intentional abort (timeout or the caller's
 *  own signal) since retrying something deliberately cancelled would ignore
 *  why it was cancelled in the first place. */
function isRetryableError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return false;
	return true;
}

// Cutting content at a hard character count can land mid-sentence or
// mid-table-row — if a paragraph break exists reasonably close to the limit,
// prefer cutting there instead so the truncated result still reads as
// complete prose up to that point. "Reasonably close" is deliberately loose
// (70% of the budget) — a boundary near the very start of a long page would
// throw away most of the allowance for no good reason.
function truncateAtBoundary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const hardCut = text.slice(0, maxChars);
	const lastBreak = hardCut.lastIndexOf("\n\n");
	if (lastBreak >= maxChars * 0.7) return hardCut.slice(0, lastBreak).trimEnd();
	return hardCut;
}

/**
 * Fetch a URL via Jina Reader (`r.jina.ai`).
 * Returns clean markdown content optimized for LLM consumption.
 */
export async function fetchUrl(
	url: string,
	options?: { maxChars?: number; signal?: AbortSignal },
): Promise<{ url: string; title: string; content: string }> {
	const maxChars = options?.maxChars ?? MAX_CONTENT_CHARS;
	const signal = options?.signal;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort(signal?.reason);
	// A signal aborted before this call ("Esc" already pressed, or the turn
	// already ended) has already fired its one-shot 'abort' event — adding a
	// listener now would never see it, silently letting the fetch run to
	// completion unaborted. Check the already-tripped state explicitly
	// instead of only listening for a future event.
	if (signal?.aborted) controller.abort(signal.reason);
	else signal?.addEventListener("abort", onAbort, { once: true });

	try {
		for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
			// The fetch call itself (network/DNS/reset failures) and a non-ok
			// HTTP response are different failure kinds with different retry
			// rules — kept in separate try/catch and if-blocks rather than one
			// shared catch, so a deliberate "this status isn't retryable" throw
			// below can't be re-caught by the network-error handler and retried
			// anyway just because it's also an Error.
			let resp: Response;
			try {
				resp = await fetch(`https://r.jina.ai/${url}`, {
					headers: {
						Accept: "text/markdown",
						"X-Return-Format": "markdown",
					},
					redirect: "follow",
					signal: controller.signal,
				});
			} catch (error) {
				if (attempt < FETCH_MAX_ATTEMPTS && isRetryableError(error)) {
					await sleep(FETCH_RETRY_DELAY_MS);
					continue;
				}
				throw error;
			}

			if (!resp.ok) {
				if (attempt < FETCH_MAX_ATTEMPTS && isRetryableStatus(resp.status)) {
					await sleep(FETCH_RETRY_DELAY_MS);
					continue;
				}
				throw new Error(`Jina Reader HTTP ${resp.status} ${resp.statusText}`);
			}

			const text = await resp.text();

			// Jina Reader's response is a metadata block followed by the actual
			// content, not a bare markdown document:
			//   Title: ...\n\nURL Source: ...\n\n[Warning: ...\n\n]Markdown Content:\n\n<content>
			let title = "";
			const titleMatch = /^Title: (.+)$/m.exec(text);
			if (titleMatch) title = titleMatch[1].trim();

			let content = text;
			const marker = "Markdown Content:";
			const markerIdx = text.indexOf(marker);
			if (markerIdx !== -1) content = text.slice(markerIdx + marker.length);

			return {
				url,
				title,
				content: truncateAtBoundary(content.trim(), maxChars),
			};
		}
		// Unreachable — the loop above always either returns or throws on its
		// last iteration — but TS can't see that, so give it a definite exit.
		throw new Error("fetchUrl: exhausted retries");
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

// ============================================================================
// Tool executors
// ============================================================================

function formatSearchResult(query: string, results: SearchResult[]): ToolResult {
	if (results.length === 0) return { content: `No results found for "${query}".` };
	const lines = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`);
	return { content: `<!--${JSON.stringify({ count: results.length })}-->\n${lines.join("\n\n")}` };
}

function missingApiKeyResult(provider: "Tavily" | "Brave"): ToolResult {
	return {
		content:
			`Error: search provider is set to ${provider} but no API key is configured. ` +
			"Set one via /web-search-provider (TUI) or the Tools settings tab (cast web), or switch back to /web-search-provider ddg.",
		isError: true,
	};
}

export async function execWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
	const query = String(args.query ?? "").trim();
	if (!query) return { content: "Error: 'query' is required.", isError: true };

	const maxResults = typeof args.maxResults === "number" ? args.maxResults : MAX_SEARCH_RESULTS;
	const region = typeof args.region === "string" ? args.region : undefined;
	const time = typeof args.time === "string" ? args.time : undefined;

	// Read fresh each call (not cached at startup) — same pattern as webTools,
	// so switching provider via /web-search-provider takes effect on the next
	// search without needing a restart.
	const settings = loadSettings();

	try {
		if (settings.searchProvider === "tavily") {
			if (!settings.tavilyApiKey) return missingApiKeyResult("Tavily");
			const { results } = await searchTavily(query, settings.tavilyApiKey, { maxResults, signal });
			return formatSearchResult(query, results);
		}
		if (settings.searchProvider === "brave") {
			if (!settings.braveApiKey) return missingApiKeyResult("Brave");
			const { results } = await searchBrave(query, settings.braveApiKey, { maxResults, signal });
			return formatSearchResult(query, results);
		}

		const { results } = await searchDuckDuckGo(query, { maxResults, region, time, signal });
		return formatSearchResult(query, results);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { content: `Search error: ${msg}`, isError: true };
	}
}

export async function execWebFetch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
	const url = String(args.url ?? "").trim();
	if (!url) return { content: "Error: 'url' is required.", isError: true };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { content: `Error: invalid URL "${url}".`, isError: true };
	}
	// Jina Reader (r.jina.ai/<url>) only ever fetches http(s) targets itself,
	// but nothing stopped a model from asking for file://, data:, or other
	// schemes here before this fetch ever reaches Jina — reject those
	// upfront with a clear reason instead of an opaque failure downstream.
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			content: `Error: unsupported URL scheme "${parsed.protocol}" — only http/https are fetchable.`,
			isError: true,
		};
	}

	const maxChars = typeof args.maxChars === "number" ? args.maxChars : MAX_CONTENT_CHARS;

	try {
		const result = await fetchUrl(url, { maxChars, signal });

		const parts: string[] = [];
		if (result.title) parts.push(`# ${result.title}`);
		parts.push(result.content || "[Empty page]");

		return { content: parts.join("\n\n") };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { content: `Fetch error: ${msg}`, isError: true };
	}
}
