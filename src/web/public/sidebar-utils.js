export const SANDBOX_CWD = "sandbox";

const SANDBOX_PATH_RE = /(?:^|[\\/])\.cast[\\/]sandbox(?:[\\/]|$)/;
const TRAILING_SLASH_RE = /[\\/]+$/;
const PATH_SEP_RE2 = /[\\/]/;

export function isSandboxSessionCwd(cwd) {
	return cwd === SANDBOX_CWD || SANDBOX_PATH_RE.test(cwd ?? "");
}

export function sessionDirectoryName(cwd) {
	if (isSandboxSessionCwd(cwd)) return "Sandbox";
	const normalized = (cwd ?? "").replace(TRAILING_SLASH_RE, "");
const name = normalized.split(PATH_SEP_RE2).filter(Boolean).at(-1);
	return name || normalized || "Unknown directory";
}

export function shortPath(path) {
	if (!path) return "";
	const parts = path.split("/").filter(Boolean);
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

export function sortSessionsByActivity(a, b) {
	const runningA = a.status === "running" ? 1 : 0;
	const runningB = b.status === "running" ? 1 : 0;
	if (runningA !== runningB) return runningB - runningA;
	return a.updatedAt < b.updatedAt ? 1 : -1;
}

export function groupSessionsByDirectory(sessions) {
	const groups = new Map();
	for (const session of sessions) {
		const key = isSandboxSessionCwd(session.cwd) ? "__sandbox__" : sessionDirectoryName(session.cwd);
		const group = groups.get(key) ?? {
			label: sessionDirectoryName(session.cwd),
			paths: new Set(),
			sessions: [],
		};
		group.paths.add(session.cwd);
		group.sessions.push(session);
		groups.set(key, group);
	}
	return [...groups].sort(([, a], [, b]) => {
		const aLatest = [...a.sessions].sort(sortSessionsByActivity)[0];
		const bLatest = [...b.sessions].sort(sortSessionsByActivity)[0];
		return sortSessionsByActivity(aLatest, bLatest);
	});
}
