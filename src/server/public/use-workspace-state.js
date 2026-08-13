import { useEffect, useRef, useState } from "preact/hooks";

export function useWorkspaceState() {
	const [diffOpen, setDiffOpen] = useState(() => {
		try {
			return localStorage.getItem("cast:diffOpen") === "1";
		} catch {
			return false;
		}
	});
	const [diffData, setDiffData] = useState(null);
	const diffRequestVersionRef = useRef(0);
	const diffRefreshRafRef = useRef(null);
	const [diffFile, setDiffFile] = useState(null);
	const [diffTab, setDiffTab] = useState(() => {
		try {
			return localStorage.getItem("cast:diffTab") || "changes";
		} catch {
			return "changes";
		}
	});
	// Bumped on every tool_end — the Files tab's tree is fetched once per
	// expanded folder and otherwise never refetched on its own, so a write/edit
	// that landed while the panel was closed must still invalidate its mounted
	// tree before the user opens it again.
	const [fsRefreshNonce, setFsRefreshNonce] = useState(0);
	const [inputsRefreshNonce, setInputsRefreshNonce] = useState(0);
	useEffect(() => {
		try {
			localStorage.setItem("cast:diffOpen", diffOpen ? "1" : "0");
		} catch {}
	}, [diffOpen]);
	useEffect(() => {
		try {
			localStorage.setItem("cast:diffTab", diffTab);
		} catch {}
	}, [diffTab]);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		try {
			const saved = Number(localStorage.getItem("cast:sidebarWidth"));
			return saved >= 272 && saved <= 420 ? saved : null;
		} catch {
			return null;
		}
	});
	useEffect(() => {
		if (!sidebarWidth) return;
		try {
			localStorage.setItem("cast:sidebarWidth", String(sidebarWidth));
		} catch {}
	}, [sidebarWidth]);
	// Dragged width, same persistence as diffOpen/diffTab above — otherwise
	// every reload snaps a manually-widened panel back to the CSS default.
	const [diffWidth, setDiffWidth] = useState(() => {
		try {
			const saved = Number(localStorage.getItem("cast:diffWidth"));
			return saved > 0 ? saved : null;
		} catch {
			return null;
		}
	});
	useEffect(() => {
		if (!diffWidth) return;
		try {
			localStorage.setItem("cast:diffWidth", String(diffWidth));
		} catch {}
	}, [diffWidth]);
	const [toasts, setToasts] = useState([]);
	const [connected, setConnected] = useState(true);
	const [backendUp, setBackendUp] = useState(true);
	// True only for the very first bootstrap (page load / hard refresh),
	// before initClientState has picked a session (or, with none saved yet,
	// staged a draft) — see the empty-state render below. Without this, a
	// reload landing on ?session=<id> shows the "Ready when you are" empty
	// thread banner for the beat it takes the GET to resolve, then swaps to
	// the real transcript — reading as the thread flashing/reloading.
	const [bootstrapping, setBootstrapping] = useState(true);
	const [atBottom, setAtBottom] = useState(true);
	const [defaultCwd, setDefaultCwd] = useState("");
	// Persona the sidebar's "Quick session" button uses — configurable in
	// Settings > Tools, defaults to "senior" server-side when never set.
	const [quickSessionPersona, setQuickSessionPersona] = useState("senior");
	// Default cwd: empty until initClientState pulls a real one from
	// /api/config. A blank value here means "show the home dir shortPath
	// (`~`) in the new-session modal until the user picks a real path" —
	// the server's /api/browse and /api/sessions both fall back to $HOME
	// when cwd is unset, so an unsubmitted selection still creates a
	// session in a sensible place.
	const [selectedCwd, setSelectedCwd] = useState("");
	const [dirPickerOpen, setDirPickerOpen] = useState(false);
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Settings' destructive actions (uninstall/remove/delete) need a Yes/No
	// gate. A single piece of state here — rather than one per callsite —
	// means one confirm modal, styled like the rest of the app instead of
	// the browser's native confirm(), reused by every "are you sure?" button.
	const [confirmState, setConfirmState] = useState(null);
	return {
		diffOpen,
		setDiffOpen,
		diffData,
		setDiffData,
		diffRequestVersionRef,
		diffRefreshRafRef,
		diffFile,
		setDiffFile,
		diffTab,
		setDiffTab,
		fsRefreshNonce,
		setFsRefreshNonce,
		inputsRefreshNonce,
		setInputsRefreshNonce,
		sidebarOpen,
		setSidebarOpen,
		sidebarCollapsed,
		setSidebarCollapsed,
		sidebarWidth,
		setSidebarWidth,
		diffWidth,
		setDiffWidth,
		toasts,
		setToasts,
		connected,
		setConnected,
		backendUp,
		setBackendUp,
		bootstrapping,
		setBootstrapping,
		atBottom,
		setAtBottom,
		defaultCwd,
		setDefaultCwd,
		quickSessionPersona,
		setQuickSessionPersona,
		selectedCwd,
		setSelectedCwd,
		dirPickerOpen,
		setDirPickerOpen,
		hotkeysOpen,
		setHotkeysOpen,
		settingsOpen,
		setSettingsOpen,
		confirmState,
		setConfirmState,
	};
}
