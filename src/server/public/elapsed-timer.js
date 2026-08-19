import htm from "htm";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const html = htm.bind(h);

// The backend timestamp is authoritative once the turn is running, so
// reconnects and page reloads keep measuring the original request rather than
// starting a new client timer. Before the turn officially starts (the daemon's
// status:running round-trip), fall back to the client-side pendingSince — the
// moment the user hit send — so the counter starts with no dead air and there
// is no need for a "sending…" label in the transcript.
//
// The two anchors live on different clocks (client vs server). The naive
// `running ? turnStartedAt : pendingSince` switch made the visible counter
// jump the moment the daemon claimed the turn. Capture the offset once on
// the first server sighting and translate `turnStartedAt` into client time
// thereafter so the counter never skips.
export function ElapsedTimer({ running, connected, turnStartedAt, pendingSince }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	const serverToClientRef = useRef(null);
	// Reset between turns so a stale offset can't be carried into the next run.
	if (turnStartedAt == null) serverToClientRef.current = null;
	let startMs;
	if (typeof turnStartedAt === "number") {
		if (serverToClientRef.current === null) {
			// Anchor against the still-pending client message when we have one —
			// this is the normal "send → status:running" handoff. After a mid-
			// turn reload there's no pending row, so fall back to Date.now() and
			// let the server timestamp seed the counter at 0.
			const anchor = typeof pendingSince === "number" ? pendingSince : Date.now();
			serverToClientRef.current = anchor - turnStartedAt;
		}
		startMs = turnStartedAt + serverToClientRef.current;
	} else {
		startMs = pendingSince;
	}
	useEffect(() => {
		if (connected && typeof startMs === "number") {
			setElapsedMs(Math.max(0, Date.now() - startMs));
			const id = setInterval(() => {
				setElapsedMs(Math.max(0, Date.now() - startMs));
			}, 250);
			return () => clearInterval(id);
		}
		const timeout = setTimeout(() => setElapsedMs(0), 5000);
		return () => clearTimeout(timeout);
	}, [connected, startMs, running]);

	if (elapsedMs <= 0) return null;
	return html`<span class="composer-elapsed">${(elapsedMs / 1000).toFixed(1)}s</span>`;
}
