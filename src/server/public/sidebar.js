import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { SidebarSessionItem } from "./sidebar-session-item.js";
import { groupSessionsByDate, SANDBOX_CWD, shortPath, sortSessionsByActivity } from "./sidebar-utils.js";

const html = htm.bind(h);

export function Sidebar({
	sessions,
	activeId,
	selectingId,
	personas,
	cwd,
	defaultCwd,
	quickSessionPersona,
	onSelectSession,
	onCreateSession,
	onOpenNewSession,
	onDeleteSession,
	onOpenDirPicker,
	onSetCwd,
	onRenameSession,
	onPinSession,
	onShareSession,
	onForkSession,
	onLogout,
	open,
	confirm,
	sessionsLoaded,
	defaultModel,
	defaultModelLoaded,
	onResizeStart,
	hasMore,
	onLoadMore,
}) {
	const [personaOpen, setPersonaOpen] = useState(false);
	const [search, setSearch] = useState("");
	// null when there's no active search (show `sessions` as-is); an array
	// once a query has resolved, already filtered and ranked server-side by
	// GET /api/sessions?q= (core/session.ts's searchSessionSummaries — SQLite
	// FTS over full message history, not just title/persona/model). Debounced
	// the same way the in-session file search above it is (300ms).
	const [searchResults, setSearchResults] = useState(null);
	const searchTimerRef = useRef(null);
	const searchAbortRef = useRef(null);
	useEffect(() => {
		clearTimeout(searchTimerRef.current);
		searchAbortRef.current?.abort();
		const q = search.trim();
		if (!q) {
			setSearchResults(null);
			return;
		}
		let cancelled = false;
		const controller = new AbortController();
		searchAbortRef.current = controller;
		searchTimerRef.current = setTimeout(() => {
			api("GET", `/api/sessions?q=${encodeURIComponent(q)}`, undefined, { signal: controller.signal })
				.then((data) => {
					if (!cancelled) setSearchResults(Array.isArray(data) ? data : []);
				})
				.catch((err) => {
					if (cancelled || controller.signal.aborted) return;
					if (err?.name === "AbortError") return;
					setSearchResults([]);
				});
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(searchTimerRef.current);
			controller.abort();
		};
	}, [search]);
	useEffect(() => () => searchAbortRef.current?.abort(), []);
	const [editingId, setEditingId] = useState(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef(null);
	const loadMoreRef = useRef(null);
	// One shared menu (Rename/Delete) rather than per-row state — opened by
	// the ⋮ button or a right-click anywhere on the row, closed by an outside
	// click/Escape/picking an action. Frees up the row for one icon instead
	// of two permanently-visible ones.
	const [menuFor, setMenuFor] = useState(null);
	const [menuPos, setMenuPos] = useState(null);
	const openMenu = useCallback((id, rowEl) => {
		if (rowEl) {
			const rect = rowEl.getBoundingClientRect();
			const ESTIMATED_MENU_HEIGHT = 190; // 4 items + padding, roomy on purpose
			// A row near the bottom of the (often short, scrolled) sidebar would
			// otherwise push the menu's default "opens downward" position past
			// the viewport edge, unreachable and unclickable — open upward instead.
			const upward = rect.bottom + ESTIMATED_MENU_HEIGHT > window.innerHeight;
			// position:fixed, computed from the row's viewport rect — rendered
			// once at the <nav> level (see menuSession below), not nested inside
			// the row, so it isn't a content-visibility descendant.
			const MENU_WIDTH = 160;
			setMenuPos({ top: upward ? rect.top - ESTIMATED_MENU_HEIGHT + 4 : rect.bottom + 4, left: rect.right - MENU_WIDTH, width: MENU_WIDTH });
		} else {
			setMenuPos(null);
		}
		setMenuFor(id);
	}, []);
	useEffect(() => {
		if (!menuFor) {
			setMenuPos(null);
			return;
		}
		const close = () => {
			setMenuFor(null);
			setMenuPos(null);
		};
		const onKey = (e) => {
			if (e.key === "Escape") close();
		};
		// Capture phase + next-tick registration: the same click that opens
		// the menu (button click / contextmenu) would otherwise immediately
		// bubble up and close it again.
		const id = setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuFor]);

	// Primary grouping is by recency (Today / Yesterday / Previous 7 days /
	// Previous 30 days / Older) — cwd is still discoverable on hover via the
	// row's title. Within each date bucket, pinned floats to the top (manual
	// anchor for ongoing work), then running, then most-recently-active.
	// Search results already come back relevance-ranked from the server —
	// respect that order (don't re-sort into the pinned/running/date groups
	// below, which only make sense for "here's everything" browsing, not "did
	// you mean this specific session").
	const isSearching = search.trim().length > 0;
	const searching = isSearching && searchResults === null;
	const filtered = isSearching ? (searchResults ?? []) : sessions;
	const sessionGroups = isSearching ? [] : groupSessionsByDate(filtered);
	const isSandbox = cwd === SANDBOX_CWD;

	useEffect(() => {
		if (!hasMore || !onLoadMore || isSearching) return;
		const el = loadMoreRef.current;
		if (!el) return;
		const obs = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting) onLoadMore();
		}, { root: el.closest(".sidebar-scroll"), threshold: 0.1 });
		obs.observe(el);
		return () => obs.disconnect();
	}, [hasMore, onLoadMore, isSearching, sessions.length]);

	const startEdit = useCallback((s) => {
		setEditingId(s.id);
		setEditValue(s.title || s.persona || "");
	}, []);
	const commitEdit = useCallback(() => {
		if (editingId) onRenameSession(editingId, editValue);
		setEditingId(null);
	}, [editingId, editValue, onRenameSession]);

	// Focus only when entering edit mode (a stable ref + effect keyed on
	// editingId), not on every keystroke — a callback ref re-invoked each
	// render would re-focus/reset the cursor on every character typed.
	useEffect(() => {
		if (editingId && editInputRef.current) {
			editInputRef.current.focus();
			editInputRef.current.select();
		}
	}, [editingId]);

	const doDelete = async (s) => {
		const sandboxNote = s.isSandbox ? " Its throwaway sandbox folder will also be deleted." : "";
		const message =
			s.status === "running"
				? `Stop the running agent and permanently delete this thread? This can't be undone.${sandboxNote}`
				: `Permanently delete this thread? This can't be undone.${sandboxNote}`;
		if (await confirm(message)) onDeleteSession(s.id);
	};

	const renderItem = (s) => html`<${SidebarSessionItem}
		session=${s}
		activeId=${activeId}
		selectingId=${selectingId}
		selecting=${selectingId === s.id}
		onSelect=${onSelectSession}
		onPin=${onPinSession}
		editingId=${editingId}
		editInputRef=${editInputRef}
		editValue=${editValue}
		setEditValue=${setEditValue}
		commitEdit=${commitEdit}
		cancelEdit=${() => setEditingId(null)}
		startEdit=${startEdit}
		menuFor=${menuFor}
		openMenu=${openMenu}
	/>`;
	// The open row's menu — rendered once here, at the <nav> level, rather
	// than inline inside the row. Rows live inside content-visibility:auto
	// containers (list virtualization for long session lists); a
	// position:fixed menu nested in there gets mispositioned (the container
	// becomes fixed's containing block) and clipped/covered by later groups
	// (containment forces a stacking context), and toggling containment off
	// to work around that forces a relayout of the whole group, which jumps
	// the scroll position. Rendering at the top level sidesteps all of it.
	const menuSession = menuFor ? filtered.find((s) => s.id === menuFor) : null;
	const renderGroup = ([key, group]) => {
		const groupSessions = [...group.sessions].sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return sortSessionsByActivity(a, b);
		});
		return html`
			<div key=${key} class="sidebar-session-group">
				<div class="sidebar-group-label">${group.label}</div>
				${groupSessions.map(renderItem)}
			</div>
		`;
	};

	return html`
		<nav class="sidebar${open ? " open" : ""}">
			<div class="sidebar-new-section">
				<div class="sidebar-new-buttons">
					<button
						class="new-session-btn"
						title="Pick a persona and directory for a new session"
						onClick=${onOpenNewSession}
					><${icons.plus} /> New session</button>
					<button
						class="new-session-btn-quick"
						title=${`Quick session — ${personas.find((p) => p.name === quickSessionPersona)?.label ?? quickSessionPersona}, fresh sandbox directory (configurable in Settings > Tools)`}
						aria-label="Quick session"
						onClick=${() => {
							setPersonaOpen(false);
							onCreateSession(quickSessionPersona, SANDBOX_CWD);
						}}
					><${icons.bolt} /></button>
				</div>
			</div>
			<div class="sidebar-divider" />
			<div class="sidebar-scroll">
				<div class="persona-list${personaOpen ? " open" : ""}">
					<div class="dir-row">
						<span class="dir-row-label">Directory</span>
						<div class="dir-toggle">
							<button
								class="dir-toggle-btn${!isSandbox ? " active" : ""}"
								title=${isSandbox ? defaultCwd : cwd}
								onClick=${isSandbox ? () => onSetCwd(null) : onOpenDirPicker}
							>${shortPath(isSandbox ? defaultCwd : cwd)}</button>
							<button
								class="dir-toggle-btn dir-toggle-sandbox${isSandbox ? " active" : ""}"
								title="Create a fresh sandbox directory for a throwaway session"
								onClick=${() => onSetCwd(SANDBOX_CWD)}
							>new</button>
						</div>
					</div>
					${personas.map(
						(p) => html`
						<div key=${p.name} class="persona-item" onClick=${() => {
							onCreateSession(p.name, cwd);
							setPersonaOpen(false);
						}}>
							${p.label}
							<span class="persona-label">${p.source}</span>
						</div>
					`,
					)}
				</div>
				<div class="sidebar-section">
					<div class="sidebar-section-title">Sessions</div>
					${
						sessions.length > 4 &&
						html`
						<input
							class="sidebar-search"
							type="text"
							placeholder="Search sessions..."
							value=${search}
							onInput=${(e) => setSearch(e.target.value)}
						/>
					`
					}
					${isSearching ? filtered.map(renderItem) : sessionGroups.map(renderGroup)}
					${!sessionsLoaded && html`<div class="sidebar-empty">Loading</div>`}
					${sessionsLoaded && searching && html`<div class="sidebar-empty">Searching…</div>`}
					${sessionsLoaded && !searching && (isSearching ? filtered.length === 0 : sessionGroups.length === 0) && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
					${!isSearching && hasMore && sessionsLoaded && html`<button ref=${loadMoreRef} class="sidebar-load-more" onClick=${onLoadMore}>Load more</button>`}
				</div>
			</div>
			<div class="sidebar-footer" title=${defaultModel || (defaultModelLoaded ? "No model selected" : "Loading")}>
				<span class="sidebar-footer-model">${defaultModel || (defaultModelLoaded ? "No model selected" : "Loading")}</span>
				<button class="sidebar-logout" onClick=${onLogout} aria-label="Log out" title="Log out">
					<${icons.arrowLeftOnRectangle} />
				</button>
			</div>
			<div class="sidebar-resize-handle" onPointerDown=${onResizeStart} aria-hidden="true" />
			${
				menuSession &&
				menuPos &&
				html`
				<div class="sidebar-item-menu" style=${`top:${menuPos.top}px;left:${menuPos.left}px;width:${menuPos.width}px;`} onClick=${(e) => e.stopPropagation()}>
					<button class="sidebar-item-menu-item" onClick=${() => {
						setMenuFor(null);
						startEdit(menuSession);
					}}><${icons.pencil} /> Rename</button>
					<button class="sidebar-item-menu-item" onClick=${() => {
						setMenuFor(null);
						onShareSession(menuSession);
					}}><${icons.link} /> Share</button>
					<button class="sidebar-item-menu-item" disabled=${menuSession.status === "running"} title=${menuSession.status === "running" ? "Wait for the agent to finish" : "Create a new session from this context"} onClick=${() => {
						setMenuFor(null);
						onForkSession(menuSession.id);
					}}><${icons.fork} /> Fork</button>
					<button class="sidebar-item-menu-item danger" onClick=${() => {
						setMenuFor(null);
						doDelete(menuSession);
					}}><${icons.trash} /> Delete</button>
				</div>`
			}
		</nav>
	`;
}
