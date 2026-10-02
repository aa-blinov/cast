export const SANDBOX_CWD = "sandbox";

const SANDBOX_PATH_RE = /(?:^|[\\/])\.cast[\\/]sandbox(?:[\\/]|$)/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Canonical bucket order — also the order rendered in the sidebar.
export const DATE_BUCKETS = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

export function isSandboxSessionCwd(cwd) {
	return cwd === SANDBOX_CWD || SANDBOX_PATH_RE.test(cwd ?? "");
}

export function shortPath(path) {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function startOfLocalDay(ts) {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

// `now` is a parameter so tests can pin a deterministic "today" without
// stubbing the global clock; sessions in the future (clock skew) clamp to
// "Today" rather than falling into a phantom bucket.
export function dateBucketFor(updatedAt, now = Date.now()) {
	const ts = Date.parse(updatedAt);
	if (Number.isNaN(ts)) return "Older";
	const days = Math.floor((startOfLocalDay(now) - startOfLocalDay(ts)) / ONE_DAY_MS);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return "Previous 7 days";
	if (days < 30) return "Previous 30 days";
	return "Older";
}

export function groupSessionsByDate(sessions, now = Date.now()) {
	const groups = new Map();
	for (const session of sessions) {
		const key = dateBucketFor(session.updatedAt, now);
		const group = groups.get(key) ?? { label: key, sessions: [] };
		group.sessions.push(session);
		groups.set(key, group);
	}
	return DATE_BUCKETS.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)]);
}

export function sortSessionsByActivity(a, b) {
	const runningA = a.status === "running" ? 1 : 0;
	const runningB = b.status === "running" ? 1 : 0;
	if (runningA !== runningB) return runningB - runningA;
	return a.updatedAt < b.updatedAt ? 1 : -1;
}

// An untitled session has nothing to tell it apart by but its persona, which every row shares:
// say an unused one is new, and give the rest the folder and age a person would look for.
export function sessionLabel(session) {
	if (session.title) return session.title;
	return session.messageCount === 0 ? "New session" : session.persona || "unknown";
}

export function relativeAge(updatedAt, now = Date.now()) {
	const ts = Date.parse(updatedAt);
	if (Number.isNaN(ts)) return "";
	const min = Math.floor((now - ts) / 60000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function sessionMeta(session, now = Date.now()) {
	const folder = session.cwd ? session.cwd.split("/").filter(Boolean).pop() : "";
	return [isSandboxSessionCwd(session.cwd) ? "sandbox" : folder, relativeAge(session.updatedAt, now)].filter(Boolean).join(" · ");
}

// A session nobody wrote in is clutter once another one is open; the one you are in stays so it does not vanish under you.
export function visibleSessions(sessions, activeId) {
	return sessions.filter((s) => s.messageCount !== 0 || s.id === activeId || s.pinned || s.status === "running");
}
