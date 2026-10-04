/**
 * Pinned sessions first, the rest as they came: a list that is paged 50 at a time would otherwise leave a session
 * pinned long ago on a later page, where "pinned" does nothing for the person looking for it.
 */
export function pinnedFirst<T extends { pinned?: boolean }>(sessions: T[]): T[] {
	const pinned: T[] = [];
	const rest: T[] = [];
	for (const session of sessions) (session.pinned ? pinned : rest).push(session);
	return pinned.length === 0 ? sessions : [...pinned, ...rest];
}
