import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";

const html = htm.bind(h);

// The backend timestamp is authoritative, so reconnects and page reloads keep
// measuring the original request rather than starting a new client timer.
export function ElapsedTimer({ running, connected, turnStartedAt }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	useEffect(() => {
		if (running && connected && typeof turnStartedAt === "number") {
			setElapsedMs(Math.max(0, Date.now() - turnStartedAt));
			const id = setInterval(() => {
				setElapsedMs(Math.max(0, Date.now() - turnStartedAt));
			}, 250);
			return () => clearInterval(id);
		}
		if (!running) {
			const timeout = setTimeout(() => setElapsedMs(0), 5000);
			return () => clearTimeout(timeout);
		}
	}, [running, connected, turnStartedAt]);

	if (elapsedMs <= 0) return null;
	return html`<span class="composer-elapsed">${(elapsedMs / 1000).toFixed(1)}s</span>`;
}
