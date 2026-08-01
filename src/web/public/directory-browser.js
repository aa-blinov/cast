import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";

const html = htm.bind(h);

export function DirectoryBrowser({ initialPath, onPick, onClose, confirm }) {
	const [path, setPath] = useState(initialPath || "");
	const [parent, setParent] = useState(null);
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const newNameRef = useRef(null);
	const loadVersionRef = useRef(0);

	const load = useCallback(async (p) => {
		const version = ++loadVersionRef.current;
		setLoading(true);
		try {
			const data = await api("GET", `/api/browse?path=${encodeURIComponent(p ?? "")}`);
			if (data && version === loadVersionRef.current) {
				setPath(data.path);
				setParent(data.parent);
				setEntries(data.entries || []);
				setError(data.error ?? null);
			}
		} catch (err) {
			if (version === loadVersionRef.current) setError(err.message);
		}
		if (version === loadVersionRef.current) setLoading(false);
	}, []);

	// initialPath seeds the first load; later navigation is controlled by clicks.
	useEffect(() => {
		load(initialPath);
	}, []);
	const modalRef = useModalFocusTrap(true);

	const openCreate = useCallback(() => {
		setCreating(true);
		setNewName("");
		requestAnimationFrame(() => newNameRef.current?.focus());
	}, []);

	const submitCreate = useCallback(async () => {
		const name = newName.trim();
		if (!name) {
			setCreating(false);
			return;
		}
		setBusy(true);
		try {
			await api("POST", "/api/browse/mkdir", { path, name });
			setCreating(false);
			await load(path);
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	}, [newName, path, load]);

	const deleteEntry = useCallback(
		async (entry) => {
			if (!(await confirm(`Delete empty folder "${entry.name}"? This can't be undone.`))) return;
			setBusy(true);
			try {
				await api("DELETE", `/api/browse?path=${encodeURIComponent(entry.path)}`);
				await load(path);
			} catch (err) {
				setError(err.message);
			}
			setBusy(false);
		},
		[confirm, path, load],
	);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal" role="dialog" aria-modal="true" aria-label="Choose working directory" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header"><span>Choose working directory</span><button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button></div>
				<div class="dir-path" title=${path}>${path}</div>
				<div class="dir-list">
					${parent !== null && html`<div class="dir-item dir-item-up" onClick=${() => load(parent)}>.. (parent directory)</div>`}
					${entries.map(
						(entry) =>
							html`<div key=${entry.path} class="dir-item dir-item-row"><span class="dir-item-name" onClick=${() => load(entry.path)}>${entry.name}</span><button class="modal-btn icon-btn dir-item-delete" title="Delete folder" disabled=${busy} onClick=${(
								event,
							) => {
								event.stopPropagation();
								deleteEntry(entry);
							}}><${icons.trash} /></button></div>`,
					)}
					${!loading && entries.length === 0 && !error && html`<div class="dir-empty">No subdirectories</div>`}
					${error && html`<div class="dir-error">${error}</div>`}
				</div>
				${
					creating
						? html`<div class="dir-create-row"><input ref=${newNameRef} type="text" placeholder="New folder name" value=${newName} disabled=${busy} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(
								e,
							) => {
								if (e.key === "Enter") submitCreate();
								if (e.key === "Escape") setCreating(false);
							}} /><button class="modal-btn" disabled=${busy} onClick=${() => setCreating(false)}>Cancel</button><button class="modal-btn modal-btn-primary" disabled=${busy || !newName.trim()} onClick=${submitCreate}>Create</button></div>`
						: html`<button class="modal-btn dir-new-folder" disabled=${busy} onClick=${openCreate}>+ New folder</button>`
				}
				<div class="modal-footer"><button class="modal-btn" onClick=${onClose}>Cancel</button><button class="modal-btn modal-btn-primary" onClick=${() => onPick(path)}>Use this folder</button></div>
			</div>
		</div>
	`;
}
