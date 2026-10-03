// Kept apart from login.js, which touches the page as it loads, so these two can be tested on their own.

/**
 * Where to go after signing in: back to the path the person was headed to, never to another site. The address is
 * resolved the way the browser will resolve it, and only the same origin is kept: a tab or a backslash in `next`
 * ("/\\t/evil.test") looks like a path but is read as "//evil.test".
 */
export function loginDestination(search, origin) {
	const next = new URLSearchParams(search).get("next");
	if (!next) return "/";
	try {
		const url = new URL(next, origin);
		return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/";
	} catch {
		return "/";
	}
}

/** The server's Retry-After (seconds) as something a person can plan around. */
export function waitText(seconds) {
	if (!(seconds > 0)) return "a while";
	if (seconds < 60) return `${Math.ceil(seconds)} seconds`;
	const minutes = Math.ceil(seconds / 60);
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
