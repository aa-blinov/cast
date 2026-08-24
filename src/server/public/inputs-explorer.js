import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { humanSize } from "./file-size.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

// Session attachments live outside the project tree and have a deliberately
// small surface: list, preview, download, and remove.
export function InputsExplorer({ activeId, confirm, refreshNonce }) {
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [busyName, setBusyName] = useState(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		if (!activeId) return;
		setLoading(true);
		try {
			const data = await api("GET", `/api/sessions/${activeId}/inputs`);
			setEntries(data?.entries ?? []);
			setError(null);
		} catch (err) {
			setError(err.message);
		} finally {
			setLoading(false);
		}
	}, [activeId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshNonce prop triggers reload when docs uploaded
	useEffect(() => {
		setError(null);
		setLoading(false);
		load();
	}, [load, refreshNonce]);

	const downloadHref = (name) => `/api/sessions/${activeId}/inputs/download?path=${encodeURIComponent(name)}`;
	const previewHref = (name) => `${downloadHref(name)}&inline=1`;
	const doDelete = async (name) => {
		if (!(await confirm(`Remove attached file "${name}"? This can't be undone.`))) return;
		setBusyName(name);
		try {
			await api("DELETE", `/api/sessions/${activeId}/inputs?path=${encodeURIComponent(name)}`);
			await load();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusyName(null);
		}
	};

	if (loading) return html`<div class="fs-explorer"><div class="diff-empty">Loading</div></div>`;
	return html`
		<div class="fs-explorer">
			${error && html`<div class="diff-empty diff-empty-error">${error}</div>`}
			${
				!error && entries.length === 0
					? html`<div class="diff-empty diff-empty-hint"><div><p class="diff-empty-title">No files attached</p><p>Attach a document from the composer's paperclip button — it'll show up here.</p></div></div>`
					: html`<div class="fs-tree">${entries.map(
							(entry) => html`
					<div key=${entry.name} class="fs-row">
						<div class="fs-row-main" onClick=${() => window.open(previewHref(entry.name), "_blank", "noopener")}>
							<span class="fs-icon"><${icons.docFile} /></span><span class="fs-name">${entry.name}</span>
							${entry.size != null ? html`<span class="fs-size">${humanSize(entry.size)}</span>` : null}
						</div>
						<div class="fs-row-actions">
							<a class="fs-action" href=${downloadHref(entry.name)} download title="Download" onClick=${(event) => event.stopPropagation()}><${icons.arrowDownTray} /></a>
							<button class="fs-action" disabled=${busyName === entry.name} title="Remove" onClick=${(event) => {
								event.stopPropagation();
								doDelete(entry.name);
							}}><${icons.trash} /></button>
						</div>
					</div>
				`,
						)}</div>`
			}
		</div>
	`;
}
