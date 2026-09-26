/** Turns per history page, the one a session opens with and each older one
 * loaded on the way up. Rendering 30 long turns at once was the longest task
 * in opening a big session, and the same again every time scrolling reached
 * the top. Every fetch of the latest page uses this size, so merges line up. */
export const HISTORY_PAGE_TURNS = 15;

export const latestPageUrl = (sessionId) => `/api/sessions/${sessionId}?turns=${HISTORY_PAGE_TURNS}`;

const isTurnMessage = (message) => message.role === "user" || message.role === "assistant";

/**
 * Merges a freshly fetched history page into the messages already on screen.
 *
 * Server rows are matched by `seq` so mounted messages keep their identity;
 * optimistic sends still waiting for their ack stay at the end.
 *
 * Rows the client made itself (`local: true`: errors, retry and abort notices,
 * command output) are never part of a history page, and a refetch at the end
 * of every turn used to drop them, which is why an error that ended a retry
 * loop vanished a moment after it appeared. They are carried over, re-anchored
 * after the same number of user/assistant messages that preceded them. That
 * count lines up because a history page has one entry per completion, the same
 * granularity the live stream appends at.
 *
 * Retries, errors and aborts are also replayed by the server from its run log
 * (rows with `notice`). A local row the page already carries, same kind and
 * same text, gives way to the server's copy; one the server never logged, such
 * as a prompt a hook blocked before the turn started, stays.
 */
export function mergeHistoryPage(previous, incoming) {
	if (!Array.isArray(incoming)) return previous;
	const incomingClientIds = new Set(incoming.map((message) => message.clientMessageId).filter(Boolean));
	const pending = previous.filter(
		(message) => message.pending === true && !incomingClientIds.has(message.clientMessageId),
	);
	if (incoming.length === 0) return pending;

	const serverNotices = new Set(
		incoming.filter((message) => message.notice).map((message) => `${message.notice}\u0000${message.content}`),
	);
	const localRows = [];
	let turnsSeen = 0;
	for (const message of previous) {
		if (message.pending === true) continue;
		if (message.local === true) {
			if (!(message.notice && serverNotices.has(`${message.notice}\u0000${message.content}`))) {
				localRows.push({ message, afterTurns: turnsSeen });
			}
		} else if (isTurnMessage(message)) turnsSeen++;
	}

	const firstSeq = incoming.find((message) => typeof message.seq === "number")?.seq;
	// Everything already loaded above this page, up to its last numbered row:
	// server rows without a seq in between (system reminders, replayed run
	// notices) belong there too and were lost when only numbered rows were kept.
	let beforeEnd = 0;
	if (typeof firstSeq === "number") {
		previous.forEach((message, i) => {
			if (typeof message.seq === "number" && message.seq < firstSeq) beforeEnd = i + 1;
		});
	}
	const before = previous.slice(0, beforeEnd).filter((message) => message.local !== true && message.pending !== true);
	const existing = new Map(
		previous.filter((message) => typeof message.seq === "number").map((message) => [message.seq, message]),
	);
	const merged = [...before, ...incoming.map((message) => existing.get(message.seq) ?? message)];
	if (localRows.length === 0) return [...merged, ...pending];

	const result = [];
	let turns = 0;
	let next = 0;
	const flushUpTo = (count) => {
		while (next < localRows.length && localRows[next].afterTurns <= count) result.push(localRows[next++].message);
	};
	flushUpTo(0);
	for (const message of merged) {
		result.push(message);
		if (isTurnMessage(message)) flushUpTo(++turns);
	}
	// Anchored past the end of what came back (the page missed some turns):
	// keep them rather than lose them.
	while (next < localRows.length) result.push(localRows[next++].message);
	return [...result, ...pending];
}
