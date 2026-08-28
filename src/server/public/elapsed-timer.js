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

// Only from SSE `status:running` (turnStartedAt). No pendingSince —
// until `running` nothing is shown, so no jump/reset.
export function ElapsedTimer({ running, connected, turnStartedAt }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	const serverToClientRef = useRef(null);
	if (turnStartedAt == null) serverToClientRef.current = null;
	let startMs;
	if (typeof turnStartedAt === "number") {
		if (serverToClientRef.current === null) {
			serverToClientRef.current = computeClockOffsetMs(turnStartedAt, Date.now());
		}
		startMs = computeStartMs(turnStartedAt, serverToClientRef.current);
	} else {
		startMs = undefined;
	}
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
