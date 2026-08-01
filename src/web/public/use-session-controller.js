import { useCallback } from "preact/hooks";
import { api } from "./api.js";

function setUrlSessionId(id, { push } = {}) {
	const url = id ? `${window.location.pathname}?session=${encodeURIComponent(id)}` : window.location.pathname;
	if (push) window.history.pushState({ sessionId: id }, "", url);
	else window.history.replaceState({ sessionId: id }, "", url);
}

export function useSessionController({
	setSessions,
	setSessionsLoaded,
	setSession,
	setActiveId,
	setRunning,
	setSidebarOpen,
	sessionsLoadVersionRef,
	sessionViewVersionRef,
	draftVersionRef,
	draftCommitsRef,
	olderPagesCacheRef,
	resetStreamingNow,
	wasRunningRef,
	undismiss,
	showToast,
	esRef,
}) {
	// Load sessions
	const loadSessions = useCallback(async () => {
		const version = ++sessionsLoadVersionRef.current;
		try {
			const data = await api("GET", "/api/sessions");
			if (version === sessionsLoadVersionRef.current) setSessions(data);
		} catch {}
		if (version === sessionsLoadVersionRef.current) setSessionsLoaded(true);
	}, [setSessions, setSessionsLoaded, sessionsLoadVersionRef]);

	// Select session — `push` controls whether this lands as a new browser
	// history entry (a real click) or just replaces the current URL
	// (programmatic: initial bootstrap, reconnect recovery, popstate).
	const selectSession = useCallback(
		async (id, { push = true, prefetch = null } = {}) => {
			const version = ++sessionViewVersionRef.current;
			++draftVersionRef.current;
			try {
				// initClientState may already have this in flight — kicked off
				// alongside (not after) the personas/session-list calls when the
				// URL names a session up front, saving a full round trip on a
				// reload landing on ?session=<id>. Falls through to a normal fetch
				// for every other caller (sidebar clicks, popstate, ...).
				const data = prefetch ? await prefetch : await api("GET", `/api/sessions/${id}`);
				if (!data) throw new Error("Not found");
				if (version !== sessionViewVersionRef.current) return;
				// Splice in older pages already loaded via scroll-up earlier this
				// tab session — only if nothing changed underneath: the cache's
				// anchorSeq is the oldestSeq the *latest* page had when caching
				// started, so a mismatch means new turns landed since (e.g. a
				// background task woke this session while looking at another
				// one) and the cache is stale for the gap. Simplest safe answer:
				// drop it and let scroll-up refetch — correctness over a saved
				// round trip in that rare case.
				const cached = olderPagesCacheRef.current.get(id);
				if (cached && cached.anchorSeq === data.oldestSeq) {
					data.messages = [...cached.messages, ...data.messages];
					data.oldestSeq = cached.oldestSeq;
					data.hasMoreHistory = cached.hasMore;
				} else {
					olderPagesCacheRef.current.set(id, {
						anchorSeq: data.oldestSeq,
						messages: [],
						oldestSeq: data.oldestSeq,
						hasMore: data.hasMoreHistory,
					});
				}
				setSession(data);
				setActiveId(id);
				resetStreamingNow();
				setRunning(data.status === "running");
				wasRunningRef.current = data.status === "running";
				setSidebarOpen(false);
				try {
					localStorage.setItem("cast:lastSessionId", id);
				} catch {}
				setUrlSessionId(id, { push });
				undismiss(id);
			} catch (err) {
				if (version === sessionViewVersionRef.current) showToast(err.message, "error");
			}
		},
		[
			showToast,
			undismiss,
			resetStreamingNow,
			setSidebarOpen,
			setActiveId,
			setRunning,
			setSession,
			draftVersionRef,
			olderPagesCacheRef.current.get,
			olderPagesCacheRef.current.set,
			sessionViewVersionRef,
			wasRunningRef,
		],
	);

	// Create session — the POST already returns the full new (empty) session,
	// so apply it directly instead of two more round trips (list + refetch)
	// before anything shows up. Internal: only ever called once, either by
	// startDraft's first-message handoff in submitMessage, or directly for
	// the handful of places that still need a session to exist immediately
	// (nothing left after this change — kept as the one place that actually
	// talks to POST /api/sessions).
	const commitSession = useCallback(
		async (persona, cwd, { push = true, draftVersion } = {}) => {
			const create = async () => api("POST", "/api/sessions", { persona, cwd });
			const pending = draftVersion == null ? create() : (draftCommitsRef.current.get(draftVersion) ?? create());
			if (draftVersion != null) draftCommitsRef.current.set(draftVersion, pending);
			let data;
			try {
				data = await pending;
			} finally {
				if (draftVersion != null && draftCommitsRef.current.get(draftVersion) === pending) {
					draftCommitsRef.current.delete(draftVersion);
				}
			}
			if (draftVersion != null && draftVersion !== draftVersionRef.current) return data.id;
			++sessionViewVersionRef.current;
			setActiveId(data.id);
			setSession({
				id: data.id,
				persona: data.session.persona,
				model: data.session.model,
				cwd: data.session.cwd,
				status: "idle",
				messages: [],
				usage: data.session.usage,
				createdAt: data.session.createdAt,
				updatedAt: data.session.updatedAt,
			});
			resetStreamingNow();
			setRunning(false);
			setSidebarOpen(false);
			try {
				localStorage.setItem("cast:lastSessionId", data.id);
			} catch {}
			setUrlSessionId(data.id, { push });
			void loadSessions();
			return data.id;
		},
		[
			loadSessions,
			resetStreamingNow,
			setSidebarOpen,
			setActiveId,
			setRunning,
			setSession,
			draftCommitsRef.current.delete,
			draftCommitsRef.current.get,
			draftCommitsRef.current.set,
			draftVersionRef.current,
			sessionViewVersionRef,
		],
	);

	// "+ New session" — picking a persona no longer hits the server at all.
	// It stages a local-only draft (persona + cwd, empty transcript) so an
	// abandoned "new chat" never shows up as a thread anywhere — the real
	// POST /api/sessions only happens from submitMessage, the first time
	// this draft actually gets a message (see there). Same idea as ChatGPT's
	// "New chat": the conversation doesn't exist until you say something.
	const startDraft = useCallback(
		(persona, draftCwd) => {
			++sessionViewVersionRef.current;
			const draftVersion = ++draftVersionRef.current;
			if (esRef.current) {
				esRef.current.close();
				esRef.current = null;
			}
			setActiveId(null);
			setSession({
				id: null,
				persona,
				model: "",
				cwd: draftCwd,
				status: "idle",
				messages: [],
				usage: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				isDraft: true,
				draftVersion,
			});
			resetStreamingNow();
			setRunning(false);
			setSidebarOpen(false);
			const url = window.location.pathname;
			window.history.pushState({ sessionId: null }, "", url);
		},
		[
			resetStreamingNow,
			setSidebarOpen,
			setActiveId,
			setRunning,
			setSession,
			draftVersionRef,
			esRef,
			sessionViewVersionRef,
		],
	);

	return { loadSessions, selectSession, commitSession, startDraft };
}
