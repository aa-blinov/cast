import { useCallback, useState } from "preact/hooks";
import { api } from "./api.js";

function setUrlSessionId(id, { push } = {}) {
	const url = id ? `${window.location.pathname}?session=${encodeURIComponent(id)}` : window.location.pathname;
	if (push) window.history.pushState({ sessionId: id }, "", url);
	else window.history.replaceState({ sessionId: id }, "", url);
}
function sessionIdFromUrl() {
	return new URLSearchParams(window.location.search).get("session");
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
	hydrateStreamingNow,
	wasRunningRef,
	undismiss,
	showToast,
	esRef,
	staticResourcesLoadedRef,
	personasRef,
	reconnectTimerRef,
	setPersonas,
	setCommands,
	setThemes,
	setCurrentThemeId,
	setDefaultCwd,
	setDefaultModel,
	setQuickSessionPersona,
	setReconnectNonce,
	setBackendUp,
	applyTheme,
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
	// `selectingId` is the id currently being fetched, surfaced to the
	// Sidebar so the row can show a spinner — a 1-2s thread-open round trip
	// with no visible feedback made clicks look dead, which got mistaken for
	// the click not registering.
	const [selectingId, setSelectingId] = useState(null);
	const selectSession = useCallback(
		async (id, { push = true, prefetch = null } = {}) => {
			const version = ++sessionViewVersionRef.current;
			++draftVersionRef.current;
			setSelectingId(id);
			// Close the sidebar immediately on click. Big threads can take a
			// second or two to load (the GET blocks until the backend's local
			// store resolves), so waiting for the response before closing
			// left the user staring at a stale list with the click visibly
			// registered only as a row highlight. The chat area already shows
			// a "Loading…" empty-state during the same window — together
			// they read as "we got it, switching" instead of "did the click
			// land?". Bootstrap / popstate paths don't pass through here, so
			// programmatic selections (no real click, no closed drawer) keep
			// their old "wait for response" timing.
			setSidebarOpen(false);
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
				hydrateStreamingNow(data.streaming);
				setRunning(data.status === "running");
				wasRunningRef.current = data.status === "running";
				try {
					localStorage.setItem("cast:lastSessionId", id);
				} catch {}
				setUrlSessionId(id, { push });
				undismiss(id);
				// Clear only if no newer selectSession has overwritten selectingId.
				// A newer call (rapid click on a different row) already set its
				// own id — clearing unconditionally here would wipe that one
				// out and the new row's spinner would never appear.
				if (version === sessionViewVersionRef.current) setSelectingId(null);
			} catch (err) {
				if (version === sessionViewVersionRef.current) {
					setSelectingId(null);
					showToast(err.message, "error");
				}
			}
		},
		[
			showToast,
			undismiss,
			hydrateStreamingNow,
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
		async (persona, cwd, { push = true, draftVersion, worktree } = {}) => {
			const create = async () => api("POST", "/api/sessions", { persona, cwd, worktree });
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
		(persona, draftCwd, opts = {}) => {
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
				// Stashed on the draft so message-submit can pass it through to
				// commitSession when the first message turns the draft into a
				// real session. Optional — only set when the new-session modal
				// asked for worktree isolation.
				worktree: opts.worktree,
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

	const forkSession = useCallback(
		async (id) => {
			try {
				const data = await api("POST", `/api/sessions/${id}/fork`);
				if (!data?.id) throw new Error("Could not fork session");
				await loadSessions();
				await selectSession(data.id);
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[loadSessions, selectSession, showToast],
	);
	// Static, rarely-changing resource lists — personas/commands/themes/config
	// — only ever need fetching once per tab. Theme changes made mid-session
	// (Settings modal, /theme) already call applyTheme()/setCurrentThemeId
	// directly, so there's nothing here that goes stale between then and a
	// reconnect. Guarded by this ref rather than state so initClientState
	// (a useCallback) doesn't need it as a dependency.

	// Full client bootstrap — on first mount, personas/commands/themes/config
	// too; every time (including reconnect), the session list, landing on
	// whichever one was last active (see selectSession's localStorage write).
	// Also used to recover after the backend goes away and comes back (see
	// startReconnectLoop below): sessions live only in-memory server-side, so
	// a backend restart loses every one of them, and re-running this exact
	// sequence is what lets the page keep working without a manual reload
	// once it's back. Re-fetching (and re-applying) the static resources on
	// every one of those reconnects too used to make the theme/persona list
	// visibly flash back in on every blip — see staticResourcesLoadedRef.
	const initClientState = useCallback(async () => {
		try {
			// Fired immediately, before anything else, so a reload landing on
			// ?session=<id> (the common case: a bookmarked/shared/reopened link)
			// doesn't pay for personas -> session list -> this session's own GET
			// as three round trips in a row when the id is already known up
			// front. Awaited down in the `s.length > 0` branch below, by which
			// point it's had the personas+session-list fetch time to resolve in
			// the background — usually free.
			const urlId = sessionIdFromUrl();
			const sessionPrefetch = urlId ? api("GET", `/api/sessions/${urlId}`).catch(() => null) : null;

			if (!staticResourcesLoadedRef.current) {
				const p = await api("GET", "/api/personas");
				if (!p) return false;
				const sortedPersonas = [...p].sort((a, b) => a.label.localeCompare(b.label));
				setPersonas(sortedPersonas);
				personasRef.current = sortedPersonas;
				api("GET", "/api/commands")
					.then((c) => c && setCommands(c))
					.catch(() => {});
				Promise.all([api("GET", "/api/themes"), api("GET", "/api/config")])
					.then(([t, cfg]) => {
						// The model belongs to app config, not the theme request. Keep
						// it available for the new-session footer independently.
						if (cfg) {
							setDefaultCwd(cfg.cwd ?? "");
							setDefaultModel(cfg.model ?? "");
							if (cfg.quickSessionPersona) setQuickSessionPersona(cfg.quickSessionPersona);
						}
						if (!t) return;
						setThemes(t);
						const current = t.find((x) => x.id === cfg?.theme) ?? t.find((x) => x.id === "cast");
						if (current) {
							applyTheme(current.colors);
							setCurrentThemeId(current.id);
						}
						// Mark loaded only after both cfg.model and themes have been
						// pushed into React state — otherwise the sidebar footer
						// renders "No model selected" for one frame between the ref
						// flip and the setDefaultModel setState landing.
						staticResourcesLoadedRef.current = true;
					})
					.catch(() => {});
			}

			const s = await api("GET", "/api/sessions");
			if (!s) return false;
			setSessions(s);
			setSessionsLoaded(true);
			if (urlId && s.find((x) => x.id === urlId)) {
				// A session is restored only when the URL explicitly names it. The
				// bare root is a deliberate fresh draft, never an implicit return to
				// a previous agent's cwd, model, or conversation.
				await selectSession(urlId, { push: false, prefetch: sessionPrefetch });
			} else {
				if (urlId) showToast("Session not found — started a new session", "error");
				const current = personasRef.current;
				const defaultP = current.find((x) => x.name === "senior") ?? current[0];
				if (defaultP) startDraft(defaultP.name, undefined);
			}
			return true;
		} catch {
			return false;
		}
	}, [
		selectSession,
		showToast,
		startDraft,
		setDefaultCwd,
		setQuickSessionPersona,
		setCommands,
		setDefaultModel,
		setPersonas,
		setSessions,
		setSessionsLoaded,
		applyTheme,
		personasRef,
		setCurrentThemeId,
		setThemes,
		staticResourcesLoadedRef,
	]);

	// The browser's own EventSource retry only covers a connection that
	// dropped after connecting fine (network blip, laptop sleep) — it does
	// NOT retry when the very first request comes back non-2xx (readyState
	// goes straight to CLOSED), which is exactly what happens when the
	// backend restarts: every session lived only in memory, so the old
	// session id 404s forever. This polls until the backend responds again,
	// then re-bootstraps and bumps reconnectNonce so the SSE effect below
	// re-subscribes even if selectSession happens to land back on the same id.
	const startReconnectLoop = useCallback(() => {
		if (reconnectTimerRef.current) return;
		// Set synchronously, before the first async attempt even starts — a
		// dropped connection can fire `onerror` more than once in a row (each
		// EventSource the SSE effect spins up during recovery has its own),
		// and without a guard that's set immediately, two overlapping retry
		// loops can each see "no sessions yet" and each create their own
		// default session (a real duplicate-session race, caught in testing).
		reconnectTimerRef.current = "pending";
		const tryOnce = async () => {
			const ok = await initClientState();
			if (ok) {
				reconnectTimerRef.current = null;
				setBackendUp(true);
				setReconnectNonce((n) => n + 1);
			} else {
				setBackendUp(false);
				reconnectTimerRef.current = setTimeout(tryOnce, 3000);
			}
		};
		tryOnce();
	}, [
		initClientState,
		setBackendUp, // Set synchronously, before the first async attempt even starts — a
		// dropped connection can fire `onerror` more than once in a row (each
		// EventSource the SSE effect spins up during recovery has its own),
		// and without a guard that's set immediately, two overlapping retry
		// loops can each see "no sessions yet" and each create their own
		// default session (a real duplicate-session race, caught in testing).
		reconnectTimerRef,
		setReconnectNonce,
	]);

	return {
		loadSessions,
		selectSession,
		selectingId,
		commitSession,
		startDraft,
		forkSession,
		initClientState,
		startReconnectLoop,
	};
}
