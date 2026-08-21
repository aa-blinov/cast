import { api } from "./api.js";

const SYSTEM_REMINDER_STRIP_RE = /\n\n<system-reminder>[\s\S]*<\/system-reminder>/;
const STEER_CMD_RE = /^\/(steer|s)\s*/;
const QUEUE_CMD_RE = /^\/(queue|q)\s*/;

export async function submitMessage(text, images, pendingDocs, context) {
	const {
		planRefineArmedRef,
		session,
		draftVersionRef,
		activeId,
		commitSession,
		showToast,
		addNotice,
		toggleDiff,
		olderPagesCacheRef,
		setSession,
		loadSessions,
		selectSession,
		setDefaultModel,
		applyTheme,
		setCurrentThemeId,
		setPendingSteers,
		setPendingQueue,
		setInputsRefreshNonce,
		waitForSessionStream,
		pendingOutgoingRef,
		setRunning,
		canSend,
	} = context;
	const connectionReady = canSend?.() ?? true;
	// If a question is pending, treat the composer text as a free-form answer
	// applied to all questions (one value, repeated). Skips the option picker
	// entirely — the user types in the composer and hits Enter, same as
	// the option buttons in QuestionCard. Skip also when the text is empty
	// or starts with a slash (command — /clear etc. takes priority).
	if (
		!images?.length &&
		!pendingDocs?.length &&
		session?.question?.questions?.length &&
		// noFreeForm questions (skill-save confirmation) have exhaustive
		// options — typing must be a new message, not a custom answer.
		!session.question.questions.some((item) => item.noFreeForm) &&
		text?.trim() &&
		!text.trim().startsWith("/")
	) {
		if (!connectionReady) {
			showToast?.("Connection lost — answer kept in the composer until the daemon reconnects", "error");
			return false;
		}
		try {
			const values = session.question.questions.map(() => text.trim());
			await api("POST", `/api/sessions/${activeId}/question`, { values });
			setSession((prev) => (prev ? { ...prev, question: undefined } : prev));
			return true;
		} catch (err) {
			showToast?.(err.message, "error");
			return false;
		}
	}

	if (planRefineArmedRef.current && !text.trim().startsWith("/")) {
		planRefineArmedRef.current = false;
		text = `The user wants to refine the plan. Update it using this feedback:\n\n${text}`;
	}
	const draftVersion = session?.isDraft ? session.draftVersion : null;
	const isCurrentDraft = () => draftVersion == null || draftVersion === draftVersionRef.current;
	// Pure client-side commands need no live (or even draft) session —
	// handled before any draft-commit below so idly hitting /diff or
	// /copy on a fresh "new session" draft can't spuriously create a
	// real backend session with nothing actually said yet.
	if (text === "/diff") {
		toggleDiff();
		return true;
	}
	if (text === "/copy") {
		const lastAssistant = [...(session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) {
			addNotice("Nothing to copy yet");
			return;
		}
		// Live-flushed messages carry `blocks`, not a flat `content` string —
		// copy the reply text only (skip reasoning/tool blocks).
		const text2 = Array.isArray(lastAssistant.blocks)
			? lastAssistant.blocks
					.filter((b) => b.kind === "content")
					.map((b) => b.text)
					.join("")
			: typeof lastAssistant.content === "string"
				? lastAssistant.content
				: JSON.stringify(lastAssistant.content);
		try {
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(text2);
			} else {
				// HTTP fallback — Clipboard API unavailable outside secure contexts.
				const ta = document.createElement("textarea");
				ta.value = text2;
				ta.style.cssText = "position:fixed;opacity:0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
			}
			addNotice("Copied to clipboard");
		} catch {
			addNotice("Copy failed", "error");
		}
		return true;
	}
	if (!connectionReady) {
		showToast?.("Connection lost — message kept in the composer until the daemon reconnects", "error");
		return false;
	}

	// Deferred documents from a draft session — upload them now that we
	// have (or are about to create) a real session id.
	let finalText = text;
	let id = activeId;
	if (pendingDocs && pendingDocs.length > 0) {
		// Must commit the session before uploading — the server needs a
		// real session id for the inputs directory.
		if (!id) {
			if (session?.isDraft) {
				try {
					id = await commitSession(session.persona, session.cwd, {
						push: true,
						draftVersion,
						worktree: session.worktree,
					});
				} catch (err) {
					showToast(err.message, "error");
					return false;
				}
			} else {
				showToast("Still connecting — try again in a moment", "error");
				return false;
			}
		}
		const paths = [];
		for (const doc of pendingDocs) {
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sequential upload required — each doc depends on session commit
				const result = await api("POST", `/api/sessions/${id}/inputs/upload`, {
					name: doc.name,
					dataUrl: doc.dataUrl,
				});
				paths.push({ name: result.name, path: result.path });
			} catch (err) {
				showToast(`Failed to upload ${doc.name}: ${err.message}`, "error");
				// Sending without the attachment would make the transcript claim
				// success while the agent can never access the user's file.
				setInputsRefreshNonce?.((n) => n + 1);
				return false;
			}
		}
		// Rebuild the system-reminder with real server-side paths —
		// replaces the placeholder text the composer stashed.
		if (paths.length > 0) {
			const userText = text.replace(SYSTEM_REMINDER_STRIP_RE, "").trim();
			finalText =
				userText +
				`\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n` +
				paths.map((p) => `- ${p.name}: ${p.path}`).join("\n") +
				`\n</system-reminder>`;
		}
		// Refresh the Inputs panel now that files are on disk
		setInputsRefreshNonce((n) => n + 1);
	}

	// The composer is enabled for a local-only draft (see startDraft) as
	// well as a real session — this is the one place a draft ever turns
	// into an actual backend session, exactly when it gets its first
	// real content, same as ChatGPT's "new chat" only existing once you
	// send something into it.
	if (!id) {
		if (session?.isDraft) {
			try {
				id = await commitSession(session.persona, session.cwd, {
					push: true,
					draftVersion,
					worktree: session.worktree,
				});
			} catch (err) {
				showToast(err.message, "error");
				return false;
			}
		} else {
			// Composer is disabled while !ready, so this only fires on a very
			// fast Enter right as the page loads — surface it instead of eating
			// the message silently.
			showToast("Still connecting — try again in a moment", "error");
			return false;
		}
	}
	// The EventSource effect may still be connecting after commitSession or
	// may still be connecting when the new session is ready to accept chat.
	// Commands wait before dispatch; normal chat waits after its optimistic row
	// is visible below.
	if (finalText.startsWith("/")) {
		if ((await waitForSessionStream?.(id)) === false) {
			showToast?.("Connection lost — command kept in the composer until the daemon reconnects", "error");
			return false;
		}
		try {
			const result = await api("POST", `/api/sessions/${id}/command`, { command: text });
			if (text === "/sessions") await loadSessions();
			if ((text.startsWith("/new") || text === "/fork") && result?.result?.sessionId) {
				await loadSessions();
				await selectSession(result.result.sessionId);
				return; // now viewing the fresh session — nothing to append a notice to
			}
			if (text === "/clear" && session) {
				olderPagesCacheRef.current.delete(id);
				setSession({ ...session, messages: [], oldestSeq: null, hasMoreHistory: false });
				return; // context just got wiped — nothing left to append a notice to
			}
			if (text.startsWith("/persona") && result?.result?.persona) {
				setSession((prev) => (prev ? { ...prev, persona: result.result.persona } : prev));
				await loadSessions();
				addNotice(`Persona: ${result.result.label ?? result.result.persona}`);
			} else if (text.startsWith("/model") && result?.result?.model) {
				setSession((prev) => (prev ? { ...prev, model: result.result.model } : prev));
				setDefaultModel(result.result.model);
				await loadSessions();
				addNotice(`Model: ${result.result.model}`);
			} else if (text.startsWith("/theme") && result?.result?.theme) {
				if (result.result.colors) applyTheme(result.result.colors);
				setCurrentThemeId(result.result.theme);
				addNotice(`Theme: ${result.result.label ?? result.result.theme}`);
			} else if (text.startsWith("/undo")) {
				if (result?.result) addNotice(result.result);
				// Refetch history and status to sync UI after undo
				await selectSession(id, { push: false });
			} else if (text.startsWith("/current") && result?.result) {
				const r = result.result;
				addNotice(`${r.persona} · ${r.model} · ${r.status} · ${r.messageCount} msg`);
			} else if (text.startsWith("/usage") && result?.result) {
				const u = result.result;
				const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
				addNotice(
					`${u.totalTokens ?? 0} tokens (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)${cost}`,
				);
			} else if (text === "/sessions" && Array.isArray(result?.result)) {
				addNotice(`${result.result.length} session${result.result.length === 1 ? "" : "s"}`);
			} else if (text.startsWith("/repo") && result?.result) {
				const r = result.result;
				addNotice(
					r.isGit ? `${r.cwd} · ${r.branch}${r.dirty ? " (dirty)" : ""}` : `${r.cwd} — not a git repository`,
				);
			} else if (text.startsWith("/reasoning") && result?.result) {
				const r = result.result;
				addNotice(
					r.note ??
						`Reasoning: ${r.reasoningLevel}${r.options?.length ? ` (options: ${r.options.join(", ")})` : ""}`,
				);
			} else if (text.startsWith("/web") && result?.result && "webTools" in result.result) {
				addNotice(`Web tools: ${result.result.webTools ? "enabled" : "disabled"}`);
			} else if ((text.startsWith("/steer") || text.startsWith("/s ")) && result?.ok) {
				const msg = text.replace(STEER_CMD_RE, "");
				if (msg) setPendingSteers((prev) => [...prev, msg]);
				addNotice(result.result);
			} else if ((text.startsWith("/queue") || text.startsWith("/q ")) && result?.ok) {
				const msg = text.replace(QUEUE_CMD_RE, "");
				if (msg) setPendingQueue((prev) => [...prev, msg]);
				addNotice(result.result);
			} else if ((text === "/queue-reset" || text === "/qr") && result?.ok) {
				setPendingQueue([]);
				addNotice(result.result);
			} else if ((text === "/plan" || text === "/build") && result?.ok) {
				const mode = text === "/plan" ? "plan" : "build";
				setSession((prev) => (prev ? { ...prev, mode } : prev));
				addNotice(result.result);
			} else if (result?.result && typeof result.result === "string") {
				addNotice(result.result);
			} else if (result?.result && typeof result.result === "object") {
				// Fallback so an object/array result is never silently swallowed —
				// this exact gap (POST succeeds, nothing visible) is what made
				// /current, /usage, and /sessions look completely broken before.
				addNotice(JSON.stringify(result.result));
			}
		} catch (err) {
			addNotice(err.message, "error");
		}
		return true;
	}
	// Show the message immediately — waiting for the POST to resolve before
	// appending it made every send feel like it had a beat of lag, even
	// though the round trip to localhost is fast. Rendered the same shape
	// toDisplayMessages produces (content: text, images: [...]) so a page
	// reload looks identical to what was just shown live.
	const clientMessageId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const outgoing = {
		sessionId: id,
		text: finalText,
		...(images?.length ? { images } : {}),
		clientMessageId,
	};
	pendingOutgoingRef.current.set(clientMessageId, outgoing);
	setSession((prev) =>
		prev?.id === id && isCurrentDraft()
			? {
					...prev,
					messages: [
						...prev.messages,
						{
							role: "user",
							content: finalText,
							...(images?.length ? { images } : {}),
							clientMessageId,
							pending: true,
							pendingAt: Date.now(),
						},
					],
				}
			: prev,
	);
	// Flip the composer to Abort the moment the message is in flight — the
	// daemon's `status:running` SSE event is the only thing that ever set
	// this before, which left the disabled Send button hanging visibly for
	// a round trip. SSE still owns the source of truth and will reconcile
	// `running` again on `end`/`error`/reconnect.
	setRunning(true);
	// The session-selection effect can render the composer before EventSource has
	// reached OPEN. Keep the prompt visible while waiting, then send only after
	// the live stream is ready so user_message/status/token events cannot race
	// past an unsubscribed browser tab.
	const streamReady = (await waitForSessionStream?.(id)) !== false;
	if (!streamReady) {
		setRunning(false);
		if (isCurrentDraft()) showToast?.("Connection lost — message kept locally until the daemon reconnects", "error");
		return true;
	}
	try {
		await api("POST", `/api/sessions/${id}/chat`, {
			text: finalText,
			...(images?.length ? { images } : {}),
			clientMessageId,
		});
		pendingOutgoingRef.current.delete(clientMessageId);
		setSession((prev) =>
			prev?.id === id
				? {
						...prev,
						messages: prev.messages.map((message) =>
							message.clientMessageId === clientMessageId ? { ...message, pending: false } : message,
						),
					}
				: prev,
		);
		// No `loadSessions()` here on purpose. The sidebar's per-session
		// summary (count, title, etc.) is pushed server-side as a
		// `session_update` SSE event after the first user message sets
		// the auto-derived title and after every turn changes the count.
		// Re-fetching the whole list was firing a redundant `/api/sessions`
		// on every single submit and stalled the optimistic feedback loop:
		// the user posted a message, saw nothing in the sidebar change,
		// then everything moved after the round trip landed.
	} catch (err) {
		setRunning(false);
		if (isCurrentDraft()) showToast(`Message kept locally; retrying when the daemon reconnects: ${err.message}`, "error");
		return false;
	}
	return true;
}
