import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { SidebarSessionItem } from "./sidebar-session-item.js";
import { groupSessionsByDirectory, SANDBOX_CWD, shortPath, sortSessionsByActivity } from "./sidebar-utils.js";

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
	onDeleteSession,
	onOpenDirPicker,
	onSetCwd,
	onRenameSession,
	onPinSession,
	onShareSession,
	onLogout,
	open,
	confirm,
	sessionsLoaded,
	defaultModel,
	onResizeStart,
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
	useEffect(() => {
		clearTimeout(searchTimerRef.current);
		const q = search.trim();
		if (!q) {
			setSearchResults(null);
			return;
		}
		// clearTimeout above only cancels a timer that hasn't fired yet — once
		// a fetch is in flight (typing continued past the 300ms debounce while
		// a slower request from an earlier keystroke was still pending),
		// there's nothing to abort it. A slow response for a stale query could
		// otherwise land after a faster response for the current one and
		// silently overwrite it with results for text that's no longer in the
		// box. `cancelled` (closed over per effect run, flipped by cleanup the
		// moment `search` changes again) makes a stale response a no-op.
		let cancelled = false;
		searchTimerRef.current = setTimeout(() => {
			api("GET", `/api/sessions?q=${encodeURIComponent(q)}`)
				.then((data) => {
					if (!cancelled) setSearchResults(Array.isArray(data) ? data : []);
				})
				.catch(() => {
					if (!cancelled) setSearchResults([]);
				});
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(searchTimerRef.current);
		};
	}, [search]);
	const [editingId, setEditingId] = useState(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef(null);
	// One shared menu (Rename/Delete) rather than per-row state — opened by
	// the ⋮ button or a right-click anywhere on the row, closed by an outside
	// click/Escape/picking an action. Frees up the row for one icon instead
	// of two permanently-visible ones.
	const [menuFor, setMenuFor] = useState(null);
	// Whether the last-opened menu should render above its anchor instead of
	// below — a row near the bottom of the (often short, scrolled) sidebar
	// otherwise had the menu's fixed "always opens downward" positioning push
	// it straight past the viewport edge, unreachable and unclickable.
	const [menuUpward, setMenuUpward] = useState(false);
	const openMenu = useCallback((id, rowEl) => {
		if (rowEl) {
			const rect = rowEl.getBoundingClientRect();
			const ESTIMATED_MENU_HEIGHT = 150; // 3 items + padding, roomy on purpose
			setMenuUpward(rect.bottom + ESTIMATED_MENU_HEIGHT > window.innerHeight);
		}
		setMenuFor(id);
	}, []);
	useEffect(() => {
		if (!menuFor) return;
		const close = () => setMenuFor(null);
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

	// Pinned is its own group above a divider (a deliberate, manual choice —
	// it shouldn't just be one more sort key mixed into the rest). Within
	// each group, running floats to the top (that's the "control room" — see
	// what's actually working), then most-recently-active.
	// Search results already come back relevance-ranked from the server —
	// respect that order (don't re-sort into the pinned/running/date groups
	// below, which only make sense for "here's everything" browsing, not "did
	// you mean this specific session").
	const isSearching = search.trim().length > 0;
	const searching = isSearching && searchResults === null;
	const filtered = isSearching ? (searchResults ?? []) : sessions;
	const sessionGroups = isSearching ? [] : groupSessionsByDirectory(filtered);
	const isSandbox = cwd === SANDBOX_CWD;

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
		const message =
			s.status === "running"
				? "Stop the running agent and permanently delete this thread? This can't be undone."
				: "Permanently delete this thread? This can't be undone.";
		if (await confirm(message)) onDeleteSession(s.id);
	};

	const renderItem = (s) => html`<${SidebarSessionItem}
		session=${s}
		activeId=${activeId}
		selecting=${selectingId === s.id}
		onSelect=${onSelectSession}
		onPin=${onPinSession}
		onDelete=${doDelete}
		onShare=${onShareSession}
		editingId=${editingId}
		editInputRef=${editInputRef}
		editValue=${editValue}
		setEditValue=${setEditValue}
		commitEdit=${commitEdit}
		cancelEdit=${() => setEditingId(null)}
		startEdit=${startEdit}
		menuFor=${menuFor}
		menuUpward=${menuUpward}
		openMenu=${openMenu}
		setMenuFor=${setMenuFor}
	/>`;
	const renderGroup = ([key, group]) => {
		const groupSessions = [...group.sessions].sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return sortSessionsByActivity(a, b);
		});
		const fullPaths = [...group.paths].filter(Boolean);
		return html`
			<div key=${key} class="sidebar-session-group">
				<div class="sidebar-group-label" title=${fullPaths.join("\n")}>${group.label}</div>
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
						onClick=${() => setPersonaOpen(!personaOpen)}
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
					${!sessionsLoaded && html`<div class="sidebar-empty">Loading sessions…</div>`}
					${sessionsLoaded && searching && html`<div class="sidebar-empty">Searching…</div>`}
					${sessionsLoaded && !searching && sessionGroups.length === 0 && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
				</div>
			</div>
			<div class="sidebar-footer" title=${defaultModel || "No model selected"}>
				<span class="sidebar-footer-model">${defaultModel || "No model selected"}</span>
				<button class="sidebar-logout" onClick=${onLogout} aria-label="Log out" title="Log out">
					<${icons.arrowLeftOnRectangle} />
				</button>
			</div>
			<div class="sidebar-resize-handle" onPointerDown=${onResizeStart} aria-hidden="true" />
		</nav>
	`;
}
