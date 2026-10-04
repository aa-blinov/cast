import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { SidebarSessionItem } from "./sidebar-session-item.js";
import {
	groupSessionsByDate,
	groupSessionsByProject,
	listProjects,
	projectLabels,
	projectOf,
	SANDBOX_CWD,
	splitPinned,
	visibleSessions,
} from "./sidebar-utils.js";

const html = htm.bind(h);

const GROUP_KEY = "cast:sidebarGroup";
// Asks for the rest of the sessions: only the first pages are loaded, and the project list is made of what is loaded.
const MORE_PROJECTS = "__more";

function readGroupBy() {
	try {
		return localStorage.getItem(GROUP_KEY) === "project" ? "project" : "date";
	} catch {
		return "date";
	}
}

export function Sidebar({
	sessions,
	activeId,
	selectingId,
	personas,
	quickSessionPersona,
	onSelectSession,
	onCreateSession,
	onOpenNewSession,
	onDeleteSession,
	onRenameSession,
	onPinSession,
	onShareSession,
	onForkSession,
	onLogout,
	open,
	collapsed,
	confirm,
	sessionsLoaded,
	defaultModel,
	defaultModelLoaded,
	resizeHandleProps,
	hasMore,
	onLoadMore,
	onLoadAll,
	loadingMore,
}) {
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
	const editInputRef = useRef(null);
	const loadMoreRef = useRef(null);
	// One shared menu (Rename/Delete) rather than per-row state — opened by
	// the ⋮ button or a right-click anywhere on the row, closed by an outside
	// click/Escape/picking an action. Frees up the row for one icon instead
	// of two permanently-visible ones.
	const [menuFor, setMenuFor] = useState(null);
	const [menuPos, setMenuPos] = useState(null);
	const menuRef = useRef(null);
	const menuAnchorRef = useRef(null);
	const openMenu = useCallback((id, rowEl) => {
		menuAnchorRef.current = rowEl?.querySelector(".sidebar-item-more") ?? null;
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
			// The mobile drawer slides in with a transform, which makes the
			// <nav> the containing block for position:fixed; offset by its
			// origin there or the menu lands a header-height below its row.
			const nav = rowEl.closest(".sidebar");
			const origin =
				nav && getComputedStyle(nav).transform !== "none" ? nav.getBoundingClientRect() : { top: 0, left: 0 };
			setMenuPos({
				top: (upward ? rect.top - ESTIMATED_MENU_HEIGHT + 4 : rect.bottom + 4) - origin.top,
				left: rect.right - MENU_WIDTH - origin.left,
				width: MENU_WIDTH,
			});
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
			if (e.key === "Escape") {
				close();
				menuAnchorRef.current?.focus();
				return;
			}
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			const items = Array.from(menuRef.current?.querySelectorAll("[role=menuitem]:not([disabled])") ?? []);
			if (items.length === 0) return;
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			const at = items.indexOf(document.activeElement);
			items[(at + step + items.length) % items.length].focus();
		};
		// Capture phase + next-tick registration: the same click that opens
		// the menu (button click / contextmenu) would otherwise immediately
		// bubble up and close it again.
		const id = setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		// menuPos is a one-shot snapshot of the anchor row's rect, taken when
		// the menu opens — it doesn't track the row afterwards. Scrolling the
		// session list or resizing the window would leave the menu visually
		// detached from its row, so close instead of trying to keep it glued
		// on (a live reposition on scroll would need a rAF loop for no real
		// benefit — nobody scrolls while reading a context menu).
		window.addEventListener("scroll", close, { capture: true, passive: true });
		window.addEventListener("resize", close);
		return () => {
			clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", close, { capture: true });
			window.removeEventListener("resize", close);
		};
	}, [menuFor]);
	// preventScroll: any scroll closes the menu (see above).
	useEffect(() => {
		if (menuPos) menuRef.current?.querySelector("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
	}, [menuPos]);

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
	const [groupBy, setGroupBy] = useState(readGroupBy);
	const [project, setProject] = useState(null);
	const chooseGroupBy = (next) => {
		setGroupBy(next);
		try {
			localStorage.setItem(GROUP_KEY, next);
		} catch {}
	};
	const shown = visibleSessions(sessions, activeId);
	const projects = listProjects(shown);
	const labels = projectLabels(projects.map((p) => p.key));
	// A project whose sessions are all gone is not a filter anymore.
	const activeProject = project && projects.some((p) => p.key === project) ? project : null;
	const base = isSearching ? (searchResults ?? []) : shown;
	const filtered = activeProject ? base.filter((s) => projectOf(s) === activeProject) : base;
	// Pinned sessions are one list above the groups, not each in its own month; a search keeps the server's ranking.
	const { pinned, rest } = isSearching ? { pinned: [], rest: filtered } : splitPinned(filtered);
	const byProject = groupBy === "project" && !activeProject;
	const sessionGroups = isSearching
		? []
		: byProject
			? groupSessionsByProject(rest).map((g) => [
					g.key,
					{ label: labels.get(g.key), title: g.key === SANDBOX_CWD ? "Throwaway sandbox folders" : g.key, count: g.sessions.length, sessions: g.sessions, project: true },
				])
			: groupSessionsByDate(rest);
	// Grouping by project and filtering by one need all of the sessions, not the pages loaded so far.
	const needsAll = (groupBy === "project" || activeProject !== null) && !isSearching;
	useEffect(() => {
		if (needsAll && hasMore && onLoadAll) onLoadAll();
	}, [needsAll, hasMore, onLoadAll]);

	useEffect(() => {
		if (!hasMore || !onLoadMore || isSearching || needsAll) return;
		const el = loadMoreRef.current;
		if (!el) return;
		const obs = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting) onLoadMore();
		}, { root: el.closest(".sidebar-scroll"), threshold: 0.1 });
		obs.observe(el);
		return () => obs.disconnect();
	}, [hasMore, onLoadMore, isSearching, needsAll, sessions.length]);

	// Escape unmounts the focused input, and the browser fires blur on the way out: without this the blur
	// handler saved the text that Escape was meant to throw away.
	const cancelledEditRef = useRef(false);
	const startEdit = useCallback((s) => {
		cancelledEditRef.current = false;
		setEditingId(s.id);
	}, []);
	const cancelEdit = useCallback(() => {
		cancelledEditRef.current = true;
		setEditingId(null);
	}, []);
	const commitEdit = useCallback(
		(value) => {
			if (cancelledEditRef.current) {
				cancelledEditRef.current = false;
				return;
			}
			if (editingId) onRenameSession(editingId, value);
			setEditingId(null);
		},
		[editingId, onRenameSession],
	);

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

	const renderItem = (s, hideFolder = false) => html`<${SidebarSessionItem}
		session=${s}
		activeId=${activeId}
		selectingId=${selectingId}
		selecting=${selectingId === s.id}
		onSelect=${onSelectSession}
		onPin=${onPinSession}
		editingId=${editingId}
		editInputRef=${editInputRef}
		commitEdit=${commitEdit}
		cancelEdit=${cancelEdit}
		startEdit=${startEdit}
		menuFor=${menuFor}
		openMenu=${openMenu}
		hideFolder=${hideFolder}
	/>`;
	const itemsOf = (list, hideFolder = false) => list.map((s) => renderItem(s, hideFolder));
	// The open row's menu — rendered once here, at the <nav> level, rather
	// than inline inside the row. Rows live inside content-visibility:auto
	// containers (list virtualization for long session lists); a
	// position:fixed menu nested in there gets mispositioned (the container
	// becomes fixed's containing block) and clipped/covered by later groups
	// (containment forces a stacking context), and toggling containment off
	// to work around that forces a relayout of the whole group, which jumps
	// the scroll position. Rendering at the top level sidesteps all of it.
	const menuSession = menuFor ? filtered.find((s) => s.id === menuFor) : null;
	const renderGroup = ([key, group]) => html`
		<div key=${key} class="sidebar-session-group">
			<h3 class="sidebar-group-label${group.project ? " sidebar-group-label-project" : ""}" title=${group.title}>${group.label}${group.count ? html`<span class="sidebar-group-count">${group.count}</span>` : null}</h3>
			${itemsOf(group.sessions, Boolean(group.project))}
		</div>
	`;

	return html`
		<nav class="sidebar${open ? " open" : ""}" aria-label="Sessions" inert=${collapsed}>
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
						onClick=${() => onCreateSession(quickSessionPersona, SANDBOX_CWD)}
					><${icons.bolt} /></button>
				</div>
			</div>
			<div class="sidebar-divider" />
			<div class="sidebar-scroll">
				<div class="sidebar-section">
					<div class="sidebar-section-head">
						<h2 class="sidebar-section-title">Sessions</h2>
						${
							sessions.length > 4 &&
							html`<div class="sidebar-group-toggle" role="group" aria-label="Group sessions">
								<button type="button" class="sidebar-group-btn" aria-pressed=${groupBy === "date"} onClick=${() => chooseGroupBy("date")}>Date</button>
								<button type="button" class="sidebar-group-btn" aria-pressed=${groupBy === "project"} onClick=${() => chooseGroupBy("project")}>Project</button>
							</div>`
						}
					</div>
					${
						sessions.length > 4 &&
						html`
						<input
							class="sidebar-search"
							type="text"
							aria-label="Search sessions"
							placeholder="Search sessions…"
							value=${search}
							onInput=${(e) => setSearch(e.target.value)}
							onKeyDown=${(e) => {
								if (e.key === "Escape" && search) {
									e.preventDefault();
									setSearch("");
								}
							}}
						/>
					`
					}
					${
						projects.length > 1 &&
						html`<select class="sidebar-project-select" aria-label="Filter by project" value=${activeProject ?? ""} onChange=${(e) => {
							if (e.target.value === MORE_PROJECTS) {
								onLoadAll?.();
								return;
							}
							setProject(e.target.value || null);
						}}>
							<option value="">All projects</option>
							${projects.map((p) => html`<option key=${p.key} value=${p.key}>${labels.get(p.key)}${hasMore ? "" : ` (${p.count})`}</option>`)}
							${hasMore && html`<option value=${MORE_PROJECTS}>Load all projects…</option>`}
						</select>`
					}
					${isSearching && !searching ? html`<div class="sr-only" role="status">${filtered.length === 1 ? "1 session found" : `${filtered.length} sessions found`}</div>` : null}
					${
						pinned.length > 0 &&
						html`<div class="sidebar-session-group sidebar-pinned"><h3 class="sidebar-group-label">Pinned</h3>${itemsOf(pinned)}</div>`
					}
					${isSearching ? itemsOf(filtered) : sessionGroups.map(renderGroup)}
					${needsAll && loadingMore && html`<div class="sidebar-hint" role="status">Loading the rest of the sessions…</div>`}
					${!sessionsLoaded && html`<div class="sidebar-empty" role="status">Loading</div>`}
					${sessionsLoaded && searching && html`<div class="sidebar-empty" role="status">Searching…</div>`}
					${sessionsLoaded && !searching && (isSearching ? filtered.length === 0 : sessionGroups.length === 0 && pinned.length === 0) && html`<div class="sidebar-empty" role="status">${isSearching ? `No sessions match "${search}"` : "No sessions yet"}</div>`}
					${!isSearching && !needsAll && hasMore && sessionsLoaded && html`<button ref=${loadMoreRef} class="sidebar-load-more" onClick=${onLoadMore} disabled=${loadingMore} aria-busy=${loadingMore ? "true" : "false"}>${loadingMore ? html`<${icons.spinner} class="sidebar-load-more-spinner" />` : "Load more"}</button>`}
				</div>
			</div>
			<div class="sidebar-footer" title=${defaultModel || (defaultModelLoaded ? "No model selected" : "Loading")}>
				<span class="sidebar-footer-model">${defaultModel || (defaultModelLoaded ? "No model selected" : "Loading")}</span>
				<button class="sidebar-logout" onClick=${onLogout} aria-label="Log out" title="Log out">
					<${icons.arrowLeftOnRectangle} />
				</button>
			</div>
			<div class="sidebar-resize-handle" ...${resizeHandleProps} />
			${
				menuSession &&
				menuPos &&
				html`
				<div class="sidebar-item-menu" role="menu" aria-label="Session actions" ref=${menuRef} style=${`top:${menuPos.top}px;left:${menuPos.left}px;width:${menuPos.width}px;`} onClick=${(e) => e.stopPropagation()}>
					<button role="menuitem" class="sidebar-item-menu-item" onClick=${() => {
						setMenuFor(null);
						startEdit(menuSession);
					}}><${icons.pencil} /> Rename</button>
					<button role="menuitem" class="sidebar-item-menu-item" onClick=${() => {
						setMenuFor(null);
						// The dialog restores focus to whatever held it; this item is about to unmount.
						menuAnchorRef.current?.focus();
						onShareSession(menuSession);
					}}><${icons.link} /> Share</button>
					<button role="menuitem" class="sidebar-item-menu-item" disabled=${menuSession.status === "running"} title=${menuSession.status === "running" ? "Wait for the agent to finish" : "Create a new session from this context"} onClick=${() => {
						setMenuFor(null);
						onForkSession(menuSession.id);
					}}><${icons.fork} /> Fork</button>
					<button role="menuitem" class="sidebar-item-menu-item danger" onClick=${() => {
						setMenuFor(null);
						// The dialog restores focus to whatever held it; this item is about to unmount.
						menuAnchorRef.current?.focus();
						doDelete(menuSession);
					}}><${icons.trash} /> Delete</button>
				</div>`
			}
		</nav>
	`;
}
