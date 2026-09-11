import htm from "htm";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const html = htm.bind(h);

/**
 * The server reports turn start as its own clock's timestamp — clients don't
 * share a clock with it, so a raw `Date.now() - turnStartedAt` would be off
 * by however far the two clocks have drifted. Captured once (by the caller,
 * on the first tick it sees a given turnStartedAt) and reused for the rest
 * of that turn so the displayed elapsed time doesn't jump if the client
 * clock or network latency shifts mid-turn.
 */
export function computeClockOffsetMs(turnStartedAt, clientNowMs) {
	return clientNowMs - turnStartedAt;
}

/** The client-clock timestamp the turn "started" at, once clock skew is known. */
export function computeStartMs(turnStartedAt, clockOffsetMs) {
	return turnStartedAt + clockOffsetMs;
}

/**
 * Where the timer counts from. The daemon's `status:running` is the authority,
 * but it costs a round trip — the composer flips to Abort the moment the send
 * leaves the browser, and the timer used to appear only once that event landed
 * (measured: 125ms on localhost, 232ms with 150ms of latency, more on a phone).
 * The send time of the message still in flight starts it immediately instead.
 *
 * Both are in client-clock terms (the server's has the skew folded in), and the
 * earliest wins: the send always precedes the turn it starts, so the displayed
 * time never jumps backwards when the server's timestamp arrives. A message
 * steered into a turn already running is later than that turn's start, which is
 * why this is a min and not "whichever we have".
 *
 * `previousStartMs` carries the answer across the moment the send stops being
 * in flight: the pending flag is cleared when the POST resolves, which is right
 * about when the status event lands, so without it the start would fall back to
 * the (later) server timestamp and the reading would drop back to 0.0s.
 */
export function resolveStartMs(serverStartMs, pendingSinceMs, previousStartMs) {
	const candidates = [serverStartMs, pendingSinceMs, previousStartMs].filter((v) => typeof v === "number");
	return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/** Never negative — a startMs that's briefly in the future (clock skew, a stale offset) shouldn't flash a negative duration. */
export function computeElapsedMs(clientNowMs, startMs) {
	return Math.max(0, clientNowMs - startMs);
}

export function formatElapsed(elapsedMs) {
	return `${(elapsedMs / 1000).toFixed(1)}s`;
}

/** Whether the ticking interval should be running at all — anything else (not running, disconnected, no confirmed start time yet) means "reset to zero, don't tick". */
export function shouldTick({ running, connected, startMs }) {
	return Boolean(running) && Boolean(connected) && typeof startMs === "number";
}

export function ElapsedTimer({ running, connected, turnStartedAt, pendingSince }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	const serverToClientRef = useRef(null);
	const startRef = useRef(undefined);
	if (turnStartedAt == null) serverToClientRef.current = null;
	let serverStartMs;
	if (typeof turnStartedAt === "number") {
		if (serverToClientRef.current === null) {
			serverToClientRef.current = computeClockOffsetMs(turnStartedAt, Date.now());
		}
		serverStartMs = computeStartMs(turnStartedAt, serverToClientRef.current);
	}
	// Sticky for the length of one turn (see resolveStartMs), dropped as soon as
	// the turn is over so the next one starts from its own send.
	if (!running) startRef.current = undefined;
	startRef.current = resolveStartMs(serverStartMs, pendingSince, startRef.current);
	const startMs = startRef.current;
	useEffect(() => {
		if (shouldTick({ running, connected, startMs })) {
			setElapsedMs(computeElapsedMs(Date.now(), startMs));
			const id = setInterval(() => {
				setElapsedMs(computeElapsedMs(Date.now(), startMs));
			}, 250);
			return () => clearInterval(id);
		}
		const timeout = setTimeout(() => setElapsedMs(0), 500);
		return () => clearTimeout(timeout);
	}, [connected, startMs, running]);

	if (!running || elapsedMs <= 0) return null;
	return html`<span class="composer-elapsed">${formatElapsed(elapsedMs)}</span>`;
}
