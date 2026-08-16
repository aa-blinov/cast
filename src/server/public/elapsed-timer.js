import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";

const html = htm.bind(h);

// The backend timestamp is authoritative once the turn is running, so
// reconnects and page reloads keep measuring the original request rather than
// starting a new client timer. Before the turn officially starts (the daemon's
// status:running round-trip), fall back to the client-side pendingSince — the
// moment the user hit send — so the counter starts with no dead air and there
// is no need for a "sending…" label in the transcript.
export function ElapsedTimer({ running, connected, turnStartedAt, pendingSince }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	// Once the daemon claims the turn, its timestamp wins (backend-authoritative);
	// otherwise keep ticking from the local send time.
	const startMs = running ? turnStartedAt : pendingSince;
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
