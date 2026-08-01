/**
 * Small REST client shared by the Web UI modules. Keeping authentication
 * redirects and error decoding in one place prevents each component from
 * inventing slightly different fetch behavior.
 */
export async function api(method, path, body) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(`${window.location.origin}${path}`, opts);
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
