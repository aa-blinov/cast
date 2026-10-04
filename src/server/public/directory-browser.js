import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { pressable, rovingRows, useModalFocusTrap } from "./modal-focus.js";

const html = htm.bind(h);

// Below this many folders the list is read at a glance; above it, a filter earns its row.
const FILTER_FROM = 8;

/** The folders whose name holds what was typed, in the order the server sent them. */
export function filterFolders(entries, query) {
	const needle = query.trim().toLowerCase();
	return needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries;
}

export function DirectoryBrowser({ initialPath, onPick, onClose, confirm }) {
	const [path, setPath] = useState(initialPath || "");
	const [pathText, setPathText] = useState(initialPath || "");
	const [parent, setParent] = useState(null);
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [filter, setFilter] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const newNameRef = useRef(null);
	const pathInputRef = useRef(null);
	const pickRef = useRef(null);
	const loadVersionRef = useRef(0);
	// The path field holds text the person typed that has not been opened yet: a load must not write over it.
	const pathEditedRef = useRef(false);

	const load = useCallback(
		async (p, hidden = showHidden, { seeding = false } = {}) => {
			const version = ++loadVersionRef.current;
			setLoading(true);
			try {
				const data = await api("GET", `/api/browse?path=${encodeURIComponent(p ?? "")}${hidden ? "&hidden=1" : ""}`);
				if (data && version === loadVersionRef.current) {
					setPath(data.path);
					// The first load starts on its own and can land while the person is already typing a path.
					if (!(seeding && pathEditedRef.current)) {
						pathEditedRef.current = false;
						setPathText(data.path);
					}
					setParent(data.parent);
					setEntries(data.entries || []);
					setError(data.error ?? null);
					setFilter("");
				}
			} catch (err) {
				if (version === loadVersionRef.current) setError(err.message);
			}
			if (version === loadVersionRef.current) setLoading(false);
		},
		[showHidden],
	);

	// initialPath seeds the first load; later navigation is controlled by clicks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new initialPath reloads; showHidden has its own handler
	useEffect(() => {
		load(initialPath, false, { seeding: true });
	}, [initialPath]);
	const modalRef = useModalFocusTrap(true);

	// A long path is cut at the right edge of its field, and the last folder is the one that "Use this folder" takes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger; the field is read through its ref
	useEffect(() => {
		const input = pathInputRef.current;
		if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
	}, [path, pathText]);

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
			const made = await api("POST", "/api/browse/mkdir", { path, name });
			setCreating(false);
			// The usual reason to make a folder here is to work in it: go in, and leave the primary button under the finger.
			await load(made?.path ?? path);
			requestAnimationFrame(() => pickRef.current?.focus());
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

	const goToTypedPath = useCallback(
		(e) => {
			e.preventDefault();
			const typed = pathText.trim();
			pathEditedRef.current = false;
			if (typed && typed !== path) load(typed);
		},
		[pathText, path, load],
	);

	// A path typed and not opened yet is opened first: "Use this folder" must take what the field says, not what was open.
	const pickFolder = useCallback(
		(e) => {
			if (pathEditedRef.current && pathText.trim() && pathText.trim() !== path) {
				goToTypedPath(e);
				return;
			}
			onPick(path);
		},
		[pathText, path, goToTypedPath, onPick],
	);

	const toggleHidden = useCallback(
		(e) => {
			setShowHidden(e.target.checked);
			load(path, e.target.checked);
		},
		[path, load],
	);

	const renderRow = (entry) => {
		const press = pressable(() => load(entry.path));
		return html`<div key=${entry.path} class="dir-item dir-item-row" role="listitem"><span class="dir-item-name" title=${entry.name} aria-keyshortcuts="Delete" ...${press} onKeyDown=${(
			e,
		) => {
			press.onKeyDown(e);
			if (e.key === "Delete" && e.target === e.currentTarget && !busy) {
				e.preventDefault();
				deleteEntry(entry);
			}
		}}>${entry.name}</span><button class="modal-btn icon-btn dir-item-delete" tabIndex="-1" title="Delete folder (Delete key)" aria-label=${`Delete ${entry.name}`} disabled=${busy} onClick=${(
			event,
		) => {
			event.stopPropagation();
			deleteEntry(entry);
		}}><${icons.trash} /></button></div>`;
	};

	const visible = filterFolders(entries, filter);
	const status = loading ? "Loading folders" : `${visible.length} ${visible.length === 1 ? "folder" : "folders"}`;

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal" role="dialog" aria-modal="true" aria-label="Choose working directory" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header"><h2 class="modal-title">Choose working directory</h2><button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button></div>
				<form class="dir-path" onSubmit=${goToTypedPath}>
					<input ref=${pathInputRef} class="dir-path-input" type="text" aria-label="Folder path" title=${path} spellcheck=${false} autocapitalize="none" autocomplete="off" value=${pathText} onInput=${(e) => {
						pathEditedRef.current = true;
						setPathText(e.target.value);
					}} onBlur=${(e) => {
						const input = e.currentTarget;
						// A field shows its start once it loses focus; the end is the part that matters here.
						requestAnimationFrame(() => {
							input.scrollLeft = input.scrollWidth;
						});
					}} onKeyDown=${(
						e,
					) => {
						if (e.key === "Escape" && pathText !== path) {
							e.preventDefault();
							pathEditedRef.current = false;
							setPathText(path);
						}
					}} />
				</form>
				<div class="dir-tools">
					${
						entries.length > FILTER_FROM || filter
							? html`<input class="dir-filter" type="text" aria-label="Filter folders" placeholder="Filter folders…" value=${filter} onInput=${(e) => setFilter(e.target.value)} onKeyDown=${(
									e,
								) => {
									if (e.key === "Escape" && filter) {
										e.preventDefault();
										setFilter("");
									}
									if (e.key === "Enter" && visible.length === 1) {
										e.preventDefault();
										load(visible[0].path);
									}
									if (e.key === "ArrowDown") {
										e.preventDefault();
										e.currentTarget.closest(".modal")?.querySelector(".dir-list [role=button]")?.focus();
									}
								}} />`
							: null
					}
					<label class="dir-hidden-toggle"><input type="checkbox" checked=${showHidden} onChange=${toggleHidden} /> Hidden</label>
				</div>
				<div class="sr-only" role="status">${status}</div>
				<div class="dir-list${loading ? " loading" : ""}" role="list" aria-label="Folders" aria-busy=${loading ? "true" : "false"} ...${rovingRows(".dir-item-name, .dir-item-up-label")}>
					${parent !== null && html`<div class="dir-item dir-item-up" role="listitem"><span class="dir-item-up-label" ...${pressable(() => load(parent))}>.. (parent directory)</span></div>`}
					${visible.map(renderRow)}
					${loading && entries.length === 0 && html`<div class="dir-empty">Loading…</div>`}
					${!loading && entries.length === 0 && !error && html`<div class="dir-empty">No subdirectories</div>`}
					${!loading && entries.length > 0 && visible.length === 0 && html`<div class="dir-empty">No folders match "${filter}"</div>`}
					${error && html`<div class="dir-error" role="alert">${error}</div>`}
				</div>
				${
					creating
						? html`<div class="dir-create-row"><input ref=${newNameRef} type="text" aria-label="New folder name" placeholder="New folder name" value=${newName} disabled=${busy} onInput=${(e) => setNewName(e.target.value)} onKeyDown=${(
								e,
							) => {
								if (e.key === "Enter") submitCreate();
								if (e.key === "Escape") {
									e.preventDefault();
									setCreating(false);
								}
							}} /><button class="modal-btn" disabled=${busy} onClick=${() => setCreating(false)}>Cancel</button><button class="modal-btn modal-btn-primary" disabled=${busy || !newName.trim()} onClick=${submitCreate}>Create</button></div>`
						: html`<button class="modal-btn dir-new-folder" disabled=${busy} onClick=${openCreate}>+ New folder</button>`
				}
				<div class="modal-footer"><button class="modal-btn" onClick=${onClose}>Cancel</button><button ref=${pickRef} class="modal-btn modal-btn-primary" onClick=${pickFolder}>Use this folder</button></div>
			</div>
		</div>
	`;
}
