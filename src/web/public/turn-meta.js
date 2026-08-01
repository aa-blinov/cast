import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);

// Turn metadata is persisted per assistant message, so historical replies
// keep the provider/model and elapsed time that produced them.
export function TurnMetaLine({ turnMeta }) {
	if (!turnMeta || turnMeta.totalMs == null) return null;
	return html`<div class="turn-meta">${turnMeta.provider} · ${turnMeta.model} · ${(turnMeta.totalMs / 1000).toFixed(1)}s</div>`;
}
