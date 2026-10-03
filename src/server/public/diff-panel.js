import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { pressable, rovingRows } from "./modal-focus.js";

const html = htm.bind(h);

// Added lines carry their new number, removed ones their old number. Context lines sit in both files: they carry
// the new number and move both counters, or every number after them is off.
export function numberHunkLines(hunk) {
	let addN = hunk.newStart;
	let delN = hunk.oldStart;
	return hunk.lines.map((line, key) => {
		const typeClass = line.type === "+" ? "diff-line-add" : line.type === "-" ? "diff-line-del" : "";
		let num;
		if (line.type === "+") num = addN++;
		else if (line.type === "-") num = delN++;
		else {
			num = addN++;
			delN++;
		}
		return { key, typeClass, num, content: line.content };
	});
}

// Arrows wrap, Home/End jump: the keys of a tab strip. -1 means the key is not ours.
export function nextTabIndex(key, at, count) {
	if (key === "ArrowRight") return (at + 1) % count;
	if (key === "ArrowLeft") return (at - 1 + count) % count;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return -1;
}

export function DiffPanel({
	InputsExplorer,
	FileExplorer: FileExplorerModule,
	MemoryExplorer: MemoryExplorerModule,
	data,
	activeFile,
	onSelectFile,
	resizeHandleProps,
	open,
	activeId,
	cwd,
	tab,
	onTabChange,
	memoryEnabled = true,
	confirm,
	fsRefreshNonce,
	inputsRefreshNonce,
	bootstrapping,
}) {
	const openClass = open ? " open" : "";

	const tabs = [
		["inputs", "Inputs"],
		["fs", "Files"],
		...(memoryEnabled ? [["memory", "Memory"]] : []),
		["changes", "Changes"],
	];
	const onTabKeyDown = (event) => {
		const next = nextTabIndex(event.key, tabs.findIndex(([id]) => id === tab), tabs.length);
		if (next < 0) return;
		event.preventDefault();
		onTabChange(tabs[next][0]);
		event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
	};

	const header = html`
		<div class="diff-header">
			<div class="diff-tabs" role="tablist" aria-label="Workspace" onKeyDown=${onTabKeyDown}>
				${tabs.map(
					([id, label]) => html`<button role="tab" id=${`workspace-tab-${id}`} aria-controls="workspace-tabpanel" aria-selected=${tab === id} tabIndex=${tab === id ? 0 : -1} class="diff-tab${tab === id ? " active" : ""}" onClick=${() => onTabChange(id)}>${label}</button>`,
				)}
			</div>
		</div>
	`;
	const shell = (children) => html`<${PanelShell} tab=${tab} openClass=${openClass} open=${open} resizeHandleProps=${resizeHandleProps} header=${header}>${children}<//>`;

	// A draft session (nothing sent yet) has no cwd on the server to diff or
	// browse — show that plainly instead of either tab's normal content
	// (which would otherwise sit on a permanent "Loading"/blank state).
	// During bootstrap, though, activeId is only briefly null while the last
	// session is still being resolved — a real session is about to load, so
	// this must say "Loading", not "No session yet" (which read as wrong the
	// instant a real session's data landed a moment later).
	if (!activeId) {
		return shell(
			bootstrapping
				? html`<div class="diff-empty" role="status">Loading</div>`
				: html`
					<div class="diff-empty diff-empty-hint">
						<div>
							<p class="diff-empty-title">No session yet</p>
							<p>Send a message to start this thread, then its changes and files show up here.</p>
						</div>
					</div>
				`,
		);
	}

	if (tab === "inputs") {
		return shell(html`<${InputsExplorer} activeId=${activeId} confirm=${confirm} refreshNonce=${inputsRefreshNonce} />`);
	}

	if (tab === "fs") {
		return shell(html`<${FileExplorerModule} activeId=${activeId} cwd=${cwd} confirm=${confirm} refreshNonce=${fsRefreshNonce} />`);
	}

	if (tab === "memory" && memoryEnabled) {
		return shell(html`<${MemoryExplorerModule} activeId=${activeId} />`);
	}

	if (!data)
		return shell(html`
			<div class="fs-skeleton" style="padding:12px">
				<div class="fs-skeleton-row"></div>
				<div class="fs-skeleton-row"></div>
				<div class="fs-skeleton-row"></div>
				<div class="fs-skeleton-row"></div>
				<div class="fs-skeleton-row"></div>
			</div>
		`);

	// Inside the shell like every other tab: a different root here remounted the header, and the focused tab with it.
	return shell(html`<${ChangesView} data=${data} activeFile=${activeFile} onSelectFile=${onSelectFile} activeId=${activeId} />`);
}

// The one frame of every tab, so the landmark and its name are written once.
function PanelShell({ tab, openClass, open, resizeHandleProps, header, children }) {
	return html`
		<aside class="diff-panel${openClass}" aria-label="Workspace panel" inert=${!open}>
			<div class="diff-resize-handle" ...${resizeHandleProps} />
			${header}
			<div class="diff-tabpanel" id="workspace-tabpanel" role="tabpanel" aria-labelledby=${`workspace-tab-${tab}`}>${children}</div>
		</aside>
	`;
}

/**
 * The Changes tab. The server sends the diff of the first few hundred changed
 * files with the list; any other file's diff is fetched when it is opened (a
 * diff costs a git process each, and `git clean` can change 20,000 files).
 */
function ChangesView({ data, activeFile, onSelectFile, activeId }) {
	const [lazy, setLazy] = useState({});
	const [loading, setLoading] = useState(null);
	const allFiles = data.files || [];
	const groups = data.groups || {};

	const groupDefs = [
		{ key: "untracked", label: "New files", cls: "badge-new" },
		{ key: "added", label: "Staged", cls: "badge-added" },
		{ key: "modified", label: "Modified", cls: "badge-modified" },
		{ key: "deleted", label: "Deleted", cls: "badge-deleted" },
		{ key: "renamed", label: "Renamed", cls: "badge-renamed" },
	];

	// Sort dirs first within each group
	const sortFiles = (arr) =>
		[...arr].sort((a, b) => {
			const aRoot = !a.path.includes("/");
			const bRoot = !b.path.includes("/");
			if (aRoot !== bRoot) return aRoot ? 1 : -1;
			return a.path.localeCompare(b.path);
		});

	const fileLookup = {};
	for (const f of allFiles) fileLookup[f.path] = f;
	// Diffs fetched on demand (see the note on ChangesView): kept per session.
	const lazyKey = (path) => `${activeId}\u0000${path}`;
	for (const [key, files] of Object.entries(lazy)) {
		if (key.startsWith(`${activeId}\u0000`)) for (const f of files) fileLookup[f.path] = f;
	}
	// A path the list names but the response carried no diff for.
	const stubFor = (path) => ({ path, stub: true, hunks: [], additions: null, deletions: null });

	// Build grouped file list with section headers
	const sections = [];
	for (const g of groupDefs) {
		const paths = groups[g.key];
		if (!paths || paths.length === 0) continue;
		const files = sortFiles(paths.map((p) => fileLookup[p] ?? stubFor(p)));
		if (files.length === 0) continue;
		sections.push({ ...g, files, total: data.groupTotals?.[g.key] ?? files.length });
	}

	const activePath = activeFile || (sections.length > 0 ? sections[0].files[0]?.path : null);
	const file = activePath ? (fileLookup[activePath] ?? stubFor(activePath)) : null;
	const wantsFetch = Boolean(file?.stub && activePath && lazy[lazyKey(activePath)] === undefined);

	useEffect(() => {
		if (!wantsFetch || !activePath) return;
		const key = lazyKey(activePath);
		const controller = new AbortController();
		setLoading(activePath);
		api("GET", `/api/sessions/${activeId}/diff/file?path=${encodeURIComponent(activePath)}`, undefined, { signal: controller.signal })
			.then((res) => setLazy((prev) => ({ ...prev, [key]: res?.files ?? [] })))
			.catch(() => setLazy((prev) => ({ ...prev, [key]: [] })))
			.finally(() => setLoading((now) => (now === activePath ? null : now)));
		return () => controller.abort();
	}, [wantsFetch, activePath, activeId]);

	// Pre-compute hunk lines
	let diffContent = null;
	if (file && !file.stub && file.hunks.length > 0) {
		diffContent = file.hunks.map((hunk, hi) => ({ hi, hunk, lines: numberHunkLines(hunk) }));
	}

	return html`
			<div class="diff-file-list" ...${rovingRows(".diff-file-item")}>
				${sections.map(
					(sec) => html`
					<div key=${sec.key}>
						<div class="diff-group-header">
							<span class="diff-group-label">${sec.label}</span>
							<span class="diff-group-count">${sec.total}</span>
						</div>
						${sec.files.map(
							(f) => html`
							<div key=${f.path} class="diff-file-item${f.path === activePath ? " active" : ""}" aria-current=${f.path === activePath ? "true" : undefined} ...${pressable(() => onSelectFile(f.path))} title=${f.path}>
								<span class="diff-file-badge ${sec.cls}"></span>
								<span class="diff-file-path">
									<span class="diff-file-dir">${f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span><span class="diff-file-base">${f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
								</span>
								${
									f.stub
										? null
										: html`<span class="diff-file-stats">
									<span class="add">+${f.additions}</span>
									<span class="del">-${f.deletions}</span>
								</span>`
								}
							</div>
						`,
						)}
						${sec.total > sec.files.length ? html`<div class="diff-group-more">and ${sec.total - sec.files.length} more not listed</div>` : null}
					</div>
				`,
				)}
			</div>
			<div class="diff-view">
				${
					diffContent
						? diffContent.map(
								(h) => html`
						<div key=${h.hi}>
							<div class="diff-hunk-header">@@ -${h.hunk.oldStart},${h.hunk.oldLines} +${h.hunk.newStart},${h.hunk.newLines} @@</div>
							${h.lines.map(
								(l) => html`
								<div key=${l.key} class="diff-line ${l.typeClass}">
									<span class="diff-line-num">${l.num}</span>
									<span class="diff-line-content">${l.content}</span>
								</div>
							`,
							)}
						</div>
					`,
							)
						: file?.stub && loading === activePath
							? html`<div class="diff-empty" role="status">Loading diff</div>`
							: file?.stub
								? html`<div class="diff-empty" role="status">No textual diff for this file</div>`
								: data.noRepo
							? html`
						<div class="diff-empty diff-empty-hint">
							<div>
								<p class="diff-empty-title">Not a git repository</p>
								<p>Ask the agent to run <code>git init</code> to enable the diff view.</p>
							</div>
						</div>
					`
							: data.error
								? html`<div class="diff-empty diff-empty-error" role="alert">${data.error}</div>`
								: html`<div class="diff-empty" role="status">No changes</div>`
				}
			</div>
	`;
}
