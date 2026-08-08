import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";

const html = htm.bind(h);

export function ShareModal({ session, onClose }) {
	const [url, setUrl] = useState(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const modalRef = useModalFocusTrap(!!session);

	useEffect(() => {
		if (!session) {
			setUrl(null);
			setCopied(false);
			return;
		}
		setBusy(true);
		api("POST", `/api/sessions/${session.id}/share`)
			.then((data) => {
				if (data) setUrl(`${window.location.origin}${data.url}`);
			})
			.finally(() => setBusy(false));
	}, [session]);

	if (!session) return null;

	const copy = async () => {
		try {
			if (navigator.clipboard) await navigator.clipboard.writeText(url);
			else {
				const ta = document.createElement("textarea");
				ta.value = url;
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
			}
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard access is optional; the link remains selectable as a fallback.
		}
	};

	const revoke = async () => {
		setBusy(true);
		try {
			await api("DELETE", `/api/sessions/${session.id}/share`);
			onClose();
		} finally {
			setBusy(false);
		}
	};

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal modal-share" role="dialog" aria-modal="true" aria-label="Share thread" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header"><span>Share "${session.title || session.persona}"</span><button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button></div>
				<div class="modal-share-body">
					<p class="modal-hint">Anyone with this link can read the conversation, read-only — no cast login needed.</p>
					${url ? html`<div class="share-link-row"><input class="share-link-input" readOnly value=${url} onClick=${(e) => e.target.select()} /><button class="modal-btn icon-btn" title="Copy link" onClick=${copy}><${copied ? icons.check : icons.link} /></button></div>` : html`<div class="modal-hint">Generating link…</div>`}
				</div>
				<div class="modal-footer"><button class="modal-btn modal-btn-danger" disabled=${busy || !url} onClick=${revoke}>Revoke link</button><button class="modal-btn" onClick=${onClose}>Done</button></div>
			</div>
		</div>
	`;
}
