import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { FilePreviewModal } from "./file-preview.js";
import { humanSize } from "./file-size.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

export function nextDirectoryRequestVersion(requests, relPath) {
	const next = (requests.get(relPath) ?? 0) + 1;
	requests.set(relPath, next);
	return next;
}

export function isCurrentDirectoryRequest(requests, relPath, version) {
	return requests.get(relPath) === version;
}

export function FileExplorer({ activeId, confirm, refreshNonce }) {
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
		async (relPath, { silent = false } = {}) => {
			const requestActiveId = activeId;
			const requestKey = `${requestActiveId}\u0000${relPath}`;
			const requestVersion = nextDirectoryRequestVersion(directoryRequestVersionsRef.current, requestKey);
			if (!silent) setLoadingDirs((prev) => new Set(prev).add(relPath));
			try {
				const data = await api("GET", `/api/sessions/${requestActiveId}/fs?path=${encodeURIComponent(relPath || ".")}`);
				const isCurrent =
					activeIdRef.current === requestActiveId &&
					isCurrentDirectoryRequest(directoryRequestVersionsRef.current, requestKey, requestVersion);
				if (!isCurrent) return;
				if (data?.entries) {
					setTree((prev) => ({ ...prev, [relPath]: data.entries }));
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

	useEffect(() => {
		directoryRequestVersionsRef.current.clear();
		lastRefreshNonceRef.current = refreshNonce;
		setTree({});
		setExpanded(new Set());
		setSearchResults(null);
		setQuery("");
		setError(null);
		if (activeId) void loadDir("");
	}, [activeId, loadDir]);

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
				const data = await api("GET", `/api/sessions/${activeId}/fs/search?q=${encodeURIComponent(q)}`);
				setSearchResults(data?.results ?? []);
			} catch (err) {
				if (err?.message?.includes("timed out")) setError(err.message);
				else setError(err.message);
			} finally {
				setSearching(false);
			}
		},
		[activeId],
	);

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
		setRenamingPath(fullPath);
		setRenameValue(currentName);
		requestAnimationFrame(() => {
			renameInputRef.current?.focus();
			renameInputRef.current?.select();
		});
	};

	const commitRename = async (fullPath) => {
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
					? html`<a class="fs-action" href=${downloadHref(fullPath)} download title="Download" onClick=${(e) => e.stopPropagation()}><${icons.arrowDownTray} /></a>`
					: null
			}
			<button
				class="fs-action"
				disabled=${isBusy}
				title="Rename"
				onClick=${(e) => {
					e.stopPropagation();
					startRename(fullPath, name);
				}}
			><${icons.pencil} /></button>
			<button
				class="fs-action"
				disabled=${isBusy}
				title=${type === "dir" ? "Delete folder" : "Delete file"}
				onClick=${(e) => {
					e.stopPropagation();
					doDelete(fullPath, type);
				}}
			><${icons.trash} /></button>
		</div>
	`;

	const renderEntry = useCallback((parentPath, entry, depth) => {
		const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
		const isDir = entry.type === "dir";
		const isOpen = expandedRef.current.has(fullPath);
		const isLoading = loadingDirsRef.current.has(fullPath);
		const isBusy = busyPath === fullPath;
		return html`
			<div key=${fullPath}>
				<div class="fs-row">
					<div class="fs-row-main" style=${{ paddingLeft: `${depth * 16}px` }} onClick=${() => (isDir ? toggleDir(fullPath) : setPreviewPath(fullPath))}>
						${
							isDir
								? html`<span class="fs-chevron${isOpen ? " open" : ""}"><${icons.chevronRight} /></span>`
								: html`<span class="fs-chevron-spacer"></span>`
						}
						<span class="fs-icon">${isDir ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
						${renderName(fullPath, entry.name)}
						${!isDir && entry.size != null ? html`<span class="fs-size">${humanSize(entry.size)}</span>` : null}
					</div>
					${renderActions(fullPath, entry.name, entry.type, isBusy)}
				</div>
				${
					isDir && isOpen
						? isLoading
							? html`<div class="fs-skeleton" style=${{ paddingLeft: `${(depth + 1) * 16}px` }}><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div></div>`
							: (treeRef.current[fullPath] || []).map((child) => renderEntry(fullPath, child, depth + 1))
						: null
				}
			</div>
		`;
	}, [busyPath, renderName, renderActions, toggleDir]);

	return html`
		<div class="fs-explorer">
			<div class="fs-toolbar">
				<input class="fs-search" placeholder="Search files…" value=${query} onInput=${(e) => onSearchInput(e.target.value)} />
				<button class="fs-collapse-btn" title="Collapse all folders" onClick=${collapseAll}><${icons.chevronUp} /></button>
			</div>
			<div class="fs-tree">
				${error ? html`<div class="diff-empty diff-empty-error">${error}</div>` : null}
				${
					searchResults
						? searching
							? html`<div class="fs-skeleton"><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div></div>`
							: searchResults.length === 0
								? html`<div class="diff-empty">No matches</div>`
								: searchResults.map((r) => {
										const baseName = r.path.includes("/")
											? r.path.slice(r.path.lastIndexOf("/") + 1)
											: r.path;
										const isBusy = busyPath === r.path;
										return html`
										<div key=${r.path} class="fs-row">
											<div class="fs-row-main" onClick=${() => r.type !== "dir" && setPreviewPath(r.path)}>
												<span class="fs-chevron-spacer"></span>
												<span class="fs-icon">${r.type === "dir" ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
												${renderName(r.path, r.path)}
											</div>
											${renderActions(r.path, baseName, r.type, isBusy)}
										</div>
									`;
									})
						: tree[""]
							? tree[""].length > 0
								? tree[""].map((entry) => renderEntry("", entry, 0))
								: html`<div class="diff-empty">No files yet</div>`
							: loadingDirs.has("")
								? html`<div class="fs-skeleton"><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div><div class="fs-skeleton-row"></div></div>`
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
