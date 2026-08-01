import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { shortPath } from "./sidebar-utils.js";

const html = htm.bind(h);

function SettingsStatus({ data }) {
	if (!data) return null;
	const current = data.current || {};
	const repo = data.repo || {};
	const usage = current.usage || {};
	const providerName = (data.providers || []).find((provider) => provider.active)?.name;
	return html`<div class="settings-rows">
		<div class="settings-row"><span>Persona</span><span>${current.persona ?? "—"}</span></div>
		${providerName ? html`<div class="settings-row"><span>Provider</span><span>${providerName}</span></div>` : null}
		<div class="settings-row"><span>Model</span><span>${current.model ?? "—"}</span></div>
		<div class="settings-row"><span>Mode</span><span>${current.mode ?? "build"}</span></div>
		<div class="settings-row"><span>Status</span><span>${current.status ?? "—"}</span></div>
		<div class="settings-row"><span>Messages</span><span>${current.messageCount ?? 0}</span></div>
		<div class="settings-row"><span>Tokens</span><span>${usage.totalTokens ?? 0} (${usage.promptTokens ?? 0} in / ${usage.completionTokens ?? 0} out)</span></div>
		${usage.cacheReadTokens > 0 && usage.promptTokens > 0 ? html`<div class="settings-row"><span>Cached</span><span>${usage.cacheReadTokens} (${Math.round((usage.cacheReadTokens / usage.promptTokens) * 100)}% of input)</span></div>` : null}
		${usage.cost ? html`<div class="settings-row"><span>Cost</span><span>$${usage.cost.toFixed(4)}</span></div>` : null}
		${current.lastTurn?.tokensPerSecond ? html`<div class="settings-row"><span>Last turn</span><span>${current.lastTurn.tokensPerSecond} tok/s (${(current.lastTurn.generationMs / 1000).toFixed(1)}s)</span></div>` : null}
		<div class="settings-row"><span>Directory</span><span title=${repo.cwd}>${shortPath(repo.cwd)}</span></div>
		${repo.isGit && html`<div class="settings-row"><span>Git branch</span><span>${repo.branch}${repo.dirty ? " (dirty)" : ""}</span></div>`}
		${repo.isGit === false && html`<div class="settings-row"><span>Git</span><span>not a repository</span></div>`}
	</div>`;
}

export function StatusPopover({ activeId, running }) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);
	const load = useCallback(async () => {
		setError(null);
		try {
			const [current, repo, providers] = await Promise.all([
				api("POST", `/api/sessions/${activeId}/command`, { command: "/current" }),
				api("POST", `/api/sessions/${activeId}/command`, { command: "/repo" }),
				api("POST", `/api/sessions/${activeId}/command`, { command: "/provider list" }),
			]);
			setData({ current: current?.result, repo: repo?.result, providers: providers?.result });
		} catch (err) {
			setError(err.message);
		}
	}, [activeId]);
	const openModal = useCallback(() => {
		setOpen(true);
		load();
	}, [load]);
	useEffect(() => {
		if (!open) return;
		const onKey = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (open && wasRunning.current && !running) load();
		wasRunning.current = running;
	}, [running, open, load]);
	const modalRef = useModalFocusTrap(open);
	return html`<button class="menu-toggle" onClick=${openModal} aria-label="Status" title="Status"><${icons.info} /></button>
		${
			open &&
			html`<div class="modal-backdrop" onClick=${() => setOpen(false)}><div class="modal modal-status" role="dialog" aria-modal="true" aria-label="Status" tabIndex="-1" ref=${modalRef} onClick=${(event) => event.stopPropagation()}>
			<div class="modal-header"><span>Status</span><button class="modal-close" onClick=${() => setOpen(false)} aria-label="Close"><${icons.xMark} /></button></div>
			<div class="modal-status-body">${error && html`<div class="settings-error">${error}</div>`}${!data && !error ? html`<div class="settings-loading">Loading…</div>` : html`<${SettingsStatus} data=${data} />`}</div>
		</div></div>`
		}`;
}
