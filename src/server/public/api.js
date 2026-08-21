/**
 * Small REST client shared by the Web UI modules. Keeping authentication
 * redirects and error decoding in one place prevents each component from
 * inventing slightly different fetch behavior.
 */
const API_TIMEOUT_MS = 15000;
const API_SLOW_TIMEOUT_MS = 30000;

function timeoutForPath(path) {
	// Session fetches can be large (multi-MB JSON + gzip) — allow extra headroom.
	if (path.includes("/api/sessions/") && (path.includes("/history") || /^\/api\/sessions\/[^/]+$/.test(path.split("?")[0]))) return API_SLOW_TIMEOUT_MS;
	return API_TIMEOUT_MS;
}

export async function api(method, path, body, { signal: externalSignal } = {}) {
	const opts = { method, headers: {}, cache: "no-store" };
	if (body !== undefined) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "AbortError")), timeoutForPath(path));
	if (externalSignal) {
		if (externalSignal.aborted) controller.abort(externalSignal.reason);
		else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
	}
	opts.signal = controller.signal;
	let res;
	try {
		res = await fetch(`${window.location.origin}${path}`, opts);
	} catch (err) {
		if (err?.name === "AbortError") throw new Error("Request timed out — server not responding");
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	if (res.status === 401) {
		// The server owns the HttpOnly session. A missing/expired cookie is a
		// navigation concern, not an API error the current view can recover from.
		window.location.assign("/login");
		return null;
	}
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
	return data;
}
