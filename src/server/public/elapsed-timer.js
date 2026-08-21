import htm from "htm";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const html = htm.bind(h);

// Only from SSE `status:running` (turnStartedAt). No pendingSince —
// until `running` nothing is shown, so no jump/reset.
export function ElapsedTimer({ running, connected, turnStartedAt }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	const serverToClientRef = useRef(null);
	if (turnStartedAt == null) serverToClientRef.current = null;
	let startMs;
	if (typeof turnStartedAt === "number") {
		if (serverToClientRef.current === null) {
			serverToClientRef.current = Date.now() - turnStartedAt;
		}
		startMs = turnStartedAt + serverToClientRef.current;
	} else {
		startMs = undefined;
	}
	useEffect(() => {
		if (running && connected && typeof startMs === "number") {
			setElapsedMs(Math.max(0, Date.now() - startMs));
			const id = setInterval(() => {
				setElapsedMs(Math.max(0, Date.now() - startMs));
			}, 250);
			return () => clearInterval(id);
		}
		const timeout = setTimeout(() => setElapsedMs(0), 500);
		return () => clearTimeout(timeout);
	}, [connected, startMs, running]);

	if (!running || elapsedMs <= 0) return null;
	return html`<span class="composer-elapsed">${(elapsedMs / 1000).toFixed(1)}s</span>`;
}
