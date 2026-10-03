import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { FilePreviewModal } from "./file-preview.js";
import { humanSize } from "./file-size.js";
import { icons } from "./icons.js";
import { pressable, rovingRows } from "./modal-focus.js";

const html = htm.bind(h);

export function nextDirectoryRequestVersion(requests, relPath) {
	const next = (requests.get(relPath) ?? 0) + 1;
	requests.set(relPath, next);
	return next;
}

export function isCurrentDirectoryRequest(requests, relPath, version) {
	return requests.get(relPath) === version;
}

export function FileExplorer({ activeId, cwd, confirm, refreshNonce }) {
	const [tree, setTree] = useState({});
	const [expanded, setExpanded] = useState(new Set());
	const [loadingDirs, setLoadingDirs] = useState(new Set());
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState(null);
	const [searching, setSearching] = useState(false);
	const [busyPath, setBusyPath] = useState(null);
	const [error, setError] = useState(null);
	const [renamingPath, setRenamingPath] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [previewPath, setPreviewPath] = useState(null);
	// Per-folder paging state: a long folder arrives 1000 entries at a time.
	const [pages, setPages] = useState({});
	const [showIgnored, setShowIgnored] = useState(false);
	const [searchInfo, setSearchInfo] = useState(null);
	const [selectedDir, setSelectedDir] = useState("");
	const [creating, setCreating] = useState(null);
	const [createValue, setCreateValue] = useState("");
	const [picked, setPicked] = useState(new Set());
	const [dropTarget, setDropTarget] = useState(null);
	const [upload, setUpload] = useState(null);
	const createInputRef = useRef(null);
	const uploadInputRef = useRef(null);
	const renameInputRef = useRef(null);
	const searchTimerRef = useRef(null);
	const directoryRequestVersionsRef = useRef(new Map());
	const activeIdRef = useRef(activeId);
	const treeRef = useRef(tree);
	const queryRef = useRef(query);
	const lastRefreshNonceRef = useRef(refreshNonce);
	const loadingDirsRef = useRef(loadingDirs);
	const expandedRef = useRef(expanded);
	activeIdRef.current = activeId;
	treeRef.current = tree;
	queryRef.current = query;
	loadingDirsRef.current = loadingDirs;
	expandedRef.current = expanded;

	const loadDir = useCallback(
		async (relPath, { silent = false, append = false } = {}) => {
			const requestActiveId = activeId;
			const requestKey = `${requestActiveId}\u0000${relPath}`;
			const requestVersion = nextDirectoryRequestVersion(directoryRequestVersionsRef.current, requestKey);
			if (!silent) setLoadingDirs((prev) => new Set(prev).add(relPath));
			try {
				const offset = append ? (treeRef.current[relPath]?.length ?? 0) : 0;
				const data = await api(
					"GET",
					`/api/sessions/${requestActiveId}/fs?path=${encodeURIComponent(relPath || ".")}${offset ? `&offset=${offset}` : ""}`,
				);
				const isCurrent =
					activeIdRef.current === requestActiveId &&
					isCurrentDirectoryRequest(directoryRequestVersionsRef.current, requestKey, requestVersion);
				if (!isCurrent) return;
				if (data?.entries) {
					setTree((prev) => ({ ...prev, [relPath]: append ? [...(prev[relPath] ?? []), ...data.entries] : data.entries }));
					setPages((prev) => ({ ...prev, [relPath]: { total: data.total, hasMore: data.hasMore } }));
					setError(null);
				} else if (data?.error) {
					setError(data.error);
				}
			} catch (err) {
				if (
					activeIdRef.current === requestActiveId &&
					isCurrentDirectoryRequest(directoryRequestVersionsRef.current, requestKey, requestVersion)
				)
					setError(err.message);
			} finally {
				setLoadingDirs((prev) => {
					if (
						activeIdRef.current !== requestActiveId ||
						!isCurrentDirectoryRequest(directoryRequestVersionsRef.current, requestKey, requestVersion)
					)
						return prev;
					const next = new Set(prev);
					next.delete(relPath);
					return next;
				});
			}
		},
		[activeId],
	);

	// The tree is keyed by the *project*, not the session: two threads in the
	// same directory show the same files, and resetting on every session
	// switch threw away every expanded folder (and refetched the root) for
	// nothing. Reset only when the cwd actually changes — or is unknown (a
	// draft has none yet).
	const lastCwdRef = useRef(undefined);
	useEffect(() => {
		if (!activeId) return;
		const sameProject = cwd != null && cwd === lastCwdRef.current && Object.keys(treeRef.current).length > 0;
		lastCwdRef.current = cwd;
		if (sameProject) return;
		directoryRequestVersionsRef.current.clear();
		lastRefreshNonceRef.current = refreshNonce;
		setTree({});
		setPages({});
		setPicked(new Set());
		setSelectedDir("");
		setExpanded(new Set());
		setSearchResults(null);
		setQuery("");
		setError(null);
		void loadDir("");
	}, [activeId, cwd, loadDir]);

	const toggleDir = (relPath) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(relPath)) {
				next.delete(relPath);
			} else {
				next.add(relPath);
				if (!treeRef.current[relPath] && !loadingDirsRef.current.has(relPath)) loadDir(relPath);
			}
			return next;
		});
	};

	const collapseAll = () => setExpanded(new Set());

	const runSearch = useCallback(
		async (q) => {
			setSearching(true);
			setError(null);
			try {
				const data = await api(
					"GET",
					`/api/sessions/${activeId}/fs/search?q=${encodeURIComponent(q)}${showIgnored ? "&ignored=1" : ""}`,
				);
				setSearchResults(data?.results ?? []);
				setSearchInfo({ total: data?.total ?? 0, truncated: data?.truncated === true });
			} catch (err) {
				setError(err.message);
			} finally {
				setSearching(false);
			}
		},
		[activeId, showIgnored],
	);

	// The toggle changes what a search may find, so an open search reruns.
	useEffect(() => {
		const q = queryRef.current.trim();
		if (q) void runSearch(q);
	}, [runSearch]);

	const onSearchInput = (value) => {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (!value.trim()) {
			setSearchResults(null);
			return;
		}
		searchTimerRef.current = setTimeout(() => runSearch(value.trim()), 300);
	};

	// A write/edit tool call while this tab is open should show up without
	// the user having to manually collapse and reopen a folder — re-fetch
	// every directory that's currently loaded (not just expanded ones still
	// visible) and re-run an active search, so new/changed/deleted files
	// surface on their own. Debounced to avoid a burst of parallel fetches
	// when several tool_end events fire in quick succession.
	const refreshTimerRef = useRef(null);
	const refreshLoaded = useCallback(() => {
		if (!activeId) return;
		if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
		refreshTimerRef.current = setTimeout(() => {
			for (const relPath of Object.keys(treeRef.current)) void loadDir(relPath, { silent: true });
			const currentQuery = queryRef.current.trim();
			if (currentQuery) void runSearch(currentQuery);
		}, 200);
	}, [activeId, loadDir, runSearch]);

	useEffect(() => {
		if (lastRefreshNonceRef.current === refreshNonce) return;
		lastRefreshNonceRef.current = refreshNonce;
		refreshLoaded();
	}, [refreshLoaded, refreshNonce]);
	useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

	const doDelete = async (relPath, type) => {
		const message =
			type === "dir"
				? `Delete folder "${relPath}" and everything inside it? This can't be undone.`
				: `Delete "${relPath}"? This can't be undone.`;
		if (!(await confirm(message))) return;
		setBusyPath(relPath);
		try {
			await api("DELETE", `/api/sessions/${activeId}/fs?path=${encodeURIComponent(relPath)}`);
			if (searchResults) {
				setSearchResults((prev) => prev.filter((r) => r.path !== relPath));
			}
			const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
			await loadDir(parent);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusyPath(null);
		}
	};

	const startRename = (fullPath, currentName) => {
		renameCommittedRef.current = false;
		setRenamingPath(fullPath);
		setRenameValue(currentName);
		requestAnimationFrame(() => {
			renameInputRef.current?.focus();
			renameInputRef.current?.select();
		});
	};

	const renameCommittedRef = useRef(false);
	const commitRename = async (fullPath) => {
		if (renameCommittedRef.current) return;
		renameCommittedRef.current = true;
		const name = renameValue.trim();
		setRenamingPath(null);
		const oldName = fullPath.includes("/") ? fullPath.slice(fullPath.lastIndexOf("/") + 1) : fullPath;
		if (!name || name === oldName) return;
		const parent = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : "";
		try {
			await api("POST", `/api/sessions/${activeId}/fs/rename`, { path: fullPath, name });
			await loadDir(parent);
			if (searchResults) runSearch(query.trim());
		} catch (err) {
			setError(err.message);
		}
	};

	const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

	const startCreate = (type) => {
		createCommittedRef.current = false;
		setCreating(type);
		setCreateValue("");
		setExpanded((prev) => (selectedDir ? new Set(prev).add(selectedDir) : prev));
		if (selectedDir && !treeRef.current[selectedDir]) void loadDir(selectedDir);
		requestAnimationFrame(() => createInputRef.current?.focus());
	};

	// Enter unmounts the input, which fires blur: without the ref the same name is created twice.
	const createCommittedRef = useRef(false);
	const commitCreate = async () => {
		if (createCommittedRef.current) return;
		createCommittedRef.current = true;
		const name = createValue.trim();
		const type = creating;
		setCreating(null);
		if (!name || !type) return;
		try {
			await api("POST", `/api/sessions/${activeId}/fs/create`, { path: selectedDir, name, type });
			await loadDir(selectedDir);
		} catch (err) {
			setError(err.message);
		}
	};

	// XHR rather than fetch: only XHR reports how much of a large file has gone up.
	const sendFile = (file, destPath, overwrite) =>
		new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open(
				"PUT",
				`/api/sessions/${activeId}/fs/upload?path=${encodeURIComponent(destPath)}${overwrite ? "&overwrite=1" : ""}`,
			);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) setUpload({ name: file.name, percent: Math.round((e.loaded / e.total) * 100) });
			};
			xhr.onload = () => {
				let message = null;
				try {
					message = JSON.parse(xhr.responseText)?.error ?? null;
				} catch {}
				resolve({ status: xhr.status, message });
			};
			xhr.onerror = () => resolve({ status: 0, message: "Upload failed" });
			xhr.send(file);
		});

	const uploadFiles = async (files, dir) => {
		for (const file of files) {
			const destPath = joinPath(dir, file.name);
			setUpload({ name: file.name, percent: 0 });
			let result = await sendFile(file, destPath, false);
			if (result.status === 409 && (await confirm(`"${destPath}" already exists. Replace it?`))) {
				setUpload({ name: file.name, percent: 0 });
				result = await sendFile(file, destPath, true);
			}
			if (result.status >= 400 || result.status === 0) {
				if (result.status !== 409) setError(result.message ?? `Upload failed (${result.status})`);
				break;
			}
		}
		setUpload(null);
		setExpanded((prev) => (dir ? new Set(prev).add(dir) : prev));
		await loadDir(dir);
	};

	const moveInto = async (fromPath, toDir) => {
		if (parentOf(fromPath) === toDir || fromPath === toDir) return;
		try {
			await api("POST", `/api/sessions/${activeId}/fs/move`, { path: fromPath, to: toDir });
			setExpanded((prev) => (toDir ? new Set(prev).add(toDir) : prev));
			await Promise.all([loadDir(parentOf(fromPath)), loadDir(toDir)]);
		} catch (err) {
			setError(err.message);
		}
	};

	const onDrop = (e, dir) => {
		e.preventDefault();
		e.stopPropagation();
		setDropTarget(null);
		const moved = e.dataTransfer.getData("application/x-cast-path");
		if (moved) void moveInto(moved, dir);
		else if (e.dataTransfer.files.length > 0) void uploadFiles([...e.dataTransfer.files], dir);
	};

	const dropProps = (dir) => ({
		onDragOver: (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (dropTarget !== dir) setDropTarget(dir);
		},
		onDragLeave: (e) => {
			e.stopPropagation();
			if (dropTarget === dir) setDropTarget(null);
		},
		onDrop: (e) => onDrop(e, dir),
	});

	const togglePicked = (path) =>
		setPicked((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	const deletePicked = async () => {
		const paths = [...picked];
		if (!(await confirm(`Delete ${paths.length} selected item${paths.length === 1 ? "" : "s"}? This can't be undone.`))) return;
		try {
			const data = await api("POST", `/api/sessions/${activeId}/fs/delete`, { paths });
			if (data?.failed?.length) setError(`Couldn't delete ${data.failed.length}: ${data.failed[0].error}`);
			setPicked(new Set());
			if (searchResults) setSearchResults((prev) => prev.filter((r) => !paths.includes(r.path)));
			await Promise.all([...new Set(paths.map(parentOf))].map((dir) => loadDir(dir)));
		} catch (err) {
			setError(err.message);
		}
	};

	const downloadHref = (relPath) => `/api/sessions/${activeId}/fs/download?path=${encodeURIComponent(relPath)}`;
	const previewHref = (relPath) => `${downloadHref(relPath)}&inline=1`;

	// Shared between the tree view and the flat search-results list — a name
	// cell that swaps to an inline rename input, and an actions cell with
	// download/rename/delete — so the two render paths don't drift apart.
	const renderName = (fullPath, name) =>
		renamingPath === fullPath
			? html`
				<input
					ref=${renameInputRef}
					class="fs-rename-input"
					value=${renameValue}
					onClick=${(e) => e.stopPropagation()}
					onInput=${(e) => setRenameValue(e.target.value)}
					onKeyDown=${(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitRename(fullPath);
						}
						if (e.key === "Escape") {
							e.preventDefault();
							renameCommittedRef.current = true;
							setRenamingPath(null);
						}
					}}
					onBlur=${() => commitRename(fullPath)}
				/>
			`
			: html`<span class="fs-name" title=${fullPath}>${name}</span>`;

	const renderActions = (fullPath, name, type, isBusy) => html`
		<div class="fs-row-actions">
			${
				type !== "dir"
					? html`<a class="fs-action" href=${downloadHref(fullPath)} download title="Download" aria-label=${`Download ${name}`} onClick=${(e) => e.stopPropagation()}><${icons.arrowDownTray} /></a>`
					: null
			}
			<button
				class="fs-action"
				disabled=${isBusy}
				title="Rename"
				aria-label=${`Rename ${name}`}
				onClick=${(e) => {
					e.stopPropagation();
					startRename(fullPath, name);
				}}
			><${icons.pencil} /></button>
			<button
				class="fs-action"
				disabled=${isBusy}
				title=${type === "dir" ? "Delete folder" : "Delete file"}
				aria-label=${`Delete ${name}`}
				onClick=${(e) => {
					e.stopPropagation();
					doDelete(fullPath, type);
				}}
			><${icons.trash} /></button>
		</div>
	`;

	const onRowActivate = (e, fullPath, isDir) => {
		if (e?.ctrlKey || e?.metaKey) return togglePicked(fullPath);
		if (isDir) {
			setSelectedDir(fullPath);
			toggleDir(fullPath);
		} else {
			setSelectedDir(parentOf(fullPath));
			setPreviewPath(fullPath);
		}
	};

	const renderEntry = (parentPath, entry, depth) => {
		const fullPath = joinPath(parentPath, entry.name);
		const isDir = entry.type === "dir";
		const isOpen = expanded.has(fullPath);
		const isLoading = loadingDirs.has(fullPath);
		const isBusy = busyPath === fullPath;
		const rowClass = `fs-row${picked.has(fullPath) ? " picked" : ""}${dropTarget === fullPath ? " drop" : ""}${selectedDir === fullPath ? " current" : ""}`;
		return html`
			<div key=${fullPath}>
				<div class=${rowClass} draggable="true" onDragStart=${(e) => e.dataTransfer.setData("application/x-cast-path", fullPath)} ...${isDir ? dropProps(fullPath) : {}}>
					<div class="fs-row-main${entry.ignored ? " ignored" : ""}" style=${{ paddingLeft: `${depth * 16}px` }} aria-expanded=${isDir ? isOpen : undefined} ...${pressable((e) => onRowActivate(e, fullPath, isDir))}>
						${
							isDir
								? html`<span class="fs-chevron${isOpen ? " open" : ""}"><${icons.chevronRight} /></span>`
								: html`<span class="fs-chevron-spacer"></span>`
						}
						<span class="fs-icon">${isDir ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
						${renderName(fullPath, entry.name)}
						${entry.ignored ? html`<span class="fs-tag">ignored</span>` : null}
						${entry.link ? html`<span class="fs-tag">${entry.broken ? "broken link" : "link"}</span>` : null}
						${!isDir && entry.size != null ? html`<span class="fs-size">${humanSize(entry.size)}</span>` : null}
					</div>
					${renderActions(fullPath, entry.name, entry.type, isBusy)}
				</div>
				${isDir && isOpen ? (isLoading && !tree[fullPath] ? skeleton(depth + 1) : renderChildren(fullPath, depth + 1)) : null}
			</div>
		`;
	};

	const skeleton = (depth = 0) =>
		html`<div class="fs-skeleton" style=${{ paddingLeft: `${depth * 16}px` }}><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div></div>`;

	const renderChildren = (dir, depth) => {
		const entries = tree[dir] ?? [];
		const page = pages[dir];
		return html`
			${entries.length === 0 ? html`<div class="fs-empty-dir" style=${{ paddingLeft: `${depth * 16 + 24}px` }}>empty</div>` : null}
			${entries.map((child) => renderEntry(dir, child, depth))}
			${
				page?.hasMore
					? html`<button class="fs-more" style=${{ marginLeft: `${depth * 16 + 8}px` }} disabled=${loadingDirs.has(dir)} onClick=${() => loadDir(dir, { append: true })}>Show more (${entries.length} of ${page.total})</button>`
					: null
			}
		`;
	};

	return html`
		<div class="fs-explorer">
			<div class="fs-toolbar">
				<input class="fs-search" aria-label="Search files" placeholder="Search files…" value=${query} onInput=${(e) => onSearchInput(e.target.value)} />
				<button class="fs-collapse-btn" title="Collapse all folders" aria-label="Collapse all folders" onClick=${collapseAll}><${icons.chevronUp} /></button>
			</div>
			<div class="fs-toolbar fs-toolbar-actions">
				<button class="fs-tool-btn" title=${selectedDir ? `New file in ${selectedDir}` : "New file"} onClick=${() => startCreate("file")}><${icons.plus} /> File</button>
				<button class="fs-tool-btn" title=${selectedDir ? `New folder in ${selectedDir}` : "New folder"} onClick=${() => startCreate("dir")}><${icons.plus} /> Folder</button>
				<button class="fs-tool-btn" title=${selectedDir ? `Upload into ${selectedDir}` : "Upload files"} onClick=${() => uploadInputRef.current?.click()}><${icons.arrowDownTray} class="fs-upload-icon" /> Upload</button>
				<label class="fs-tool-toggle" title="Include files ignored by git in the search"><input type="checkbox" checked=${showIgnored} onChange=${(e) => setShowIgnored(e.target.checked)} /> ignored</label>
				<input ref=${uploadInputRef} type="file" multiple hidden onChange=${(e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) void uploadFiles(files, selectedDir); }} />
			</div>
			${
				picked.size > 0
					? html`<div class="fs-selection"><span>${picked.size} selected</span><button class="fs-tool-btn" onClick=${deletePicked}><${icons.trash} /> Delete</button><button class="fs-tool-btn" onClick=${() => setPicked(new Set())}>Clear</button></div>`
					: null
			}
			${
				upload
					? html`<div class="fs-upload" role="status"><span class="fs-upload-name">${upload.name}</span><progress max="100" value=${upload.percent}></progress><span>${upload.percent}%</span></div>`
					: null
			}
			<div class="fs-tree${dropTarget === "" ? " drop" : ""}" ...${dropProps("")} ...${rovingRows(".fs-row-main")}>
				${error ? html`<div class="fs-error" role="alert"><span>${error}</span><button type="button" class="fs-error-dismiss" aria-label="Dismiss" onClick=${() => setError(null)}><${icons.xMark} /></button></div>` : null}
				${
					creating
						? html`<div class="fs-row fs-create-row"><span class="fs-icon">${creating === "dir" ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span><input ref=${createInputRef} class="fs-rename-input" aria-label=${creating === "dir" ? "New folder name" : "New file name"} placeholder=${`${selectedDir ? `${selectedDir}/` : ""}${creating === "dir" ? "folder" : "file.txt"} (a/b/c.txt works)`} value=${createValue} onInput=${(e) => setCreateValue(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); void commitCreate(); } if (e.key === "Escape") { e.preventDefault(); createCommittedRef.current = true; setCreating(null); } }} onBlur=${() => void commitCreate()} /></div>`
						: null
				}
				${
					searchResults
						? searching
							? skeleton()
							: searchResults.length === 0
								? html`<div class="diff-empty">No matches</div>`
								: html`
									${searchResults.map((r) => {
										const baseName = r.path.includes("/") ? r.path.slice(r.path.lastIndexOf("/") + 1) : r.path;
										const isBusy = busyPath === r.path;
										return html`
										<div key=${r.path} class="fs-row${picked.has(r.path) ? " picked" : ""}">
											<div class="fs-row-main" ...${pressable((e) => (e?.ctrlKey || e?.metaKey ? togglePicked(r.path) : r.type !== "dir" ? setPreviewPath(r.path) : null))}>
												<span class="fs-chevron-spacer"></span>
												<span class="fs-icon">${r.type === "dir" ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
												${renderName(r.path, r.path)}
											</div>
											${renderActions(r.path, baseName, r.type, isBusy)}
										</div>
									`;
									})}
									${searchInfo?.truncated ? html`<div class="fs-more-note">Showing ${searchResults.length} of ${searchInfo.total}${searchInfo.total <= searchResults.length ? "+ (the project is larger than the index)" : ""}. Refine the search to narrow it.</div>` : null}
								`
						: tree[""]
							? tree[""].length > 0
								? renderChildren("", 0)
								: html`<div class="diff-empty">No files yet</div>`
							: loadingDirs.has("")
								? skeleton()
								: null
				}
			</div>
		</div>
		<${FilePreviewModal}
			path=${previewPath}
			onClose=${() => setPreviewPath(null)}
			downloadHref=${previewPath ? downloadHref(previewPath) : null}
			previewHref=${previewPath ? previewHref(previewPath) : null}
		/>
	`;
}
