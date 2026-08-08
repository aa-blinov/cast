import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);

export function DiffPanel({
	InputsExplorer,
	FileExplorer: FileExplorerModule,
	data,
	activeFile,
	onSelectFile,
	onResizeStart,
	open,
	activeId,
	tab,
	onTabChange,
	confirm,
	fsRefreshNonce,
	inputsRefreshNonce,
	bootstrapping,
}) {
	const openClass = open ? " open" : "";

	const header = html`
		<div class="diff-header">
			<div class="diff-tabs">
				<button class="diff-tab${tab === "inputs" ? " active" : ""}" onClick=${() => onTabChange("inputs")}>Inputs</button>
				<button class="diff-tab${tab === "fs" ? " active" : ""}" onClick=${() => onTabChange("fs")}>Files</button>
				<button class="diff-tab${tab === "changes" ? " active" : ""}" onClick=${() => onTabChange("changes")}>Changes</button>
			</div>
		</div>
	`;

	// A draft session (nothing sent yet) has no cwd on the server to diff or
	// browse — show that plainly instead of either tab's normal content
	// (which would otherwise sit on a permanent "Loading…"/blank state).
	// During bootstrap, though, activeId is only briefly null while the last
	// session is still being resolved — a real session is about to load, so
	// this must say "Loading", not "No session yet" (which read as wrong the
	// instant a real session's data landed a moment later).
	if (!activeId) {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				${
					bootstrapping
						? html`<div class="diff-empty">Loading…</div>`
						: html`
						<div class="diff-empty diff-empty-hint">
							<div>
								<p class="diff-empty-title">No session yet</p>
								<p>Send a message to start this thread, then its changes and files show up here.</p>
							</div>
						</div>
					`
				}
			</aside>
		`;
	}

	if (tab === "inputs") {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				<${InputsExplorer} activeId=${activeId} confirm=${confirm} refreshNonce=${inputsRefreshNonce} />
			</aside>
		`;
	}

	if (tab === "fs") {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				<${FileExplorerModule} activeId=${activeId} confirm=${confirm} refreshNonce=${fsRefreshNonce} />
			</aside>
		`;
	}

	if (!data)
		return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			${header}
			<div class="diff-empty">Loading...</div>
		</aside>
	`;

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

	// Build grouped file list with section headers
	const sections = [];
	for (const g of groupDefs) {
		const paths = groups[g.key];
		if (!paths || paths.length === 0) continue;
		const files = sortFiles(paths.map((p) => fileLookup[p]).filter(Boolean));
		if (files.length === 0) continue;
		sections.push({ ...g, files });
	}

	const activePath = activeFile || (sections.length > 0 ? sections[0].files[0]?.path : null);
	const file = activePath ? fileLookup[activePath] : null;

	// Pre-compute hunk lines
	let diffContent = null;
	if (file && file.hunks.length > 0) {
		diffContent = file.hunks.map((hunk, hi) => {
			let addN = hunk.newStart;
			let delN = hunk.oldStart;
			const lines = hunk.lines.map((line, li) => {
				const typeClass = line.type === "+" ? "diff-line-add" : line.type === "-" ? "diff-line-del" : "";
				let num = "";
				if (line.type === "+") {
					num = addN;
					addN++;
				} else if (line.type === "-") {
					num = delN;
					delN++;
				}
				return { key: li, typeClass, num, content: line.content };
			});
			return { hi, hunk, lines };
		});
	}

	return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			${header}
			<div class="diff-file-list">
				${sections.map(
					(sec) => html`
					<div key=${sec.key}>
						<div class="diff-group-header">
							<span class="diff-group-label">${sec.label}</span>
							<span class="diff-group-count">${sec.files.length}</span>
						</div>
						${sec.files.map(
							(f) => html`
							<div key=${f.path} class="diff-file-item${f.path === activePath ? " active" : ""}" onClick=${() => onSelectFile(f.path)} title=${f.path}>
								<span class="diff-file-badge ${sec.cls}"></span>
								<span class="diff-file-path">
									<span class="diff-file-dir">${f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span><span class="diff-file-base">${f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
								</span>
								<span class="diff-file-stats">
									<span class="add">+${f.additions}</span>
									<span class="del">-${f.deletions}</span>
								</span>
							</div>
						`,
						)}
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
								? html`<div class="diff-empty diff-empty-error">${data.error}</div>`
								: html`<div class="diff-empty">No changes</div>`
				}
			</div>
		</aside>
	`;
}
