import { blocksFromAssistantCompletion } from "./stream-blocks.js";

function normalizeUserContent(content) {
	if (typeof content === "string") return { text: content, images: [] };
	if (Array.isArray(content)) {
		return {
			text: content.find((part) => part.type === "text")?.text ?? "",
			images: content.filter((part) => part.type === "image_url").map((part) => part.image_url.url),
		};
	}
	return { text: "", images: [] };
}

/** Replaces the single "[Retrying..." warning row in place, or appends one —
 *  a retry storm updates one row instead of spamming the transcript. */
function upsertRetryRow(messages, text) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "warning" && typeof m.content === "string" && m.content.startsWith("[Retrying")) {
			const next = messages.slice();
			next[i] = { role: "warning", content: text };
			return next;
		}
	}
	return [...messages, { role: "warning", content: text }];
}

/** Drops any lingering "[Retrying..." warning row once real content streams —
 *  the retry belongs to the waiting phase, not the reply. Returns the same
 *  array reference when there's nothing to strip. */
function isRetryRow(m) {
	return Boolean(m) && m.role === "warning" && typeof m.content === "string" && m.content.startsWith("[Retrying");
}

function stripRetryRow(messages) {
	// Checked before building anything: this runs on every token and thinking
	// event, and a retry row is present for a fraction of a second at most —
	// so the common case is a scan that finds nothing, and allocating a copy
	// of the whole loaded transcript per token just to discard it was pure GC
	// churn at 50+ tokens/s on a session with thousands of messages.
	if (!messages.some(isRetryRow)) return messages;
	return messages.filter((m) => !isRetryRow(m));
}

/** Short chime for "the turn finished", on a lazily-created shared context. */
let chimeContext;
function playTurnDoneChime() {
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return;
	if (!chimeContext) chimeContext = new AC();
	const ctx = chimeContext;
	// A context created before any user gesture starts suspended; resuming is a
	// no-op when it's already running.
	if (ctx.state === "suspended") ctx.resume().catch(() => {});
	const o = ctx.createOscillator();
	const g = ctx.createGain();
	o.type = "sine";
	o.frequency.value = 880;
	g.gain.value = 0.12;
	o.connect(g).connect(ctx.destination);
	o.start();
	g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
	setTimeout(() => {
		try {
			o.stop();
			o.disconnect();
			g.disconnect();
		} catch {}
	}, 320);
}

export function handleSseEvent(event, context) {
	const {
		streamSessionId,
		setSession,
		setSessions,
		setRunning,
		setPendingSteers,
		setPendingQueue,
		setPlanTransition,
		pendingPlanSignalRef,
		selfClosingRef,
		activeId,
		wasRunningRef,
		updateStreaming,
		resetStreamingNow,
		takeStreamingNow,
		diffOpenRef,
		queueDiffRefresh,
		setFsRefreshNonce,
		addNotice,
		showToast,
		api,
		isCurrent,
		mergeHistoryPage,
	} = context;

	switch (event.type) {
		case "user_message": {
			setSession((prev) => {
				if (!prev) return prev;
				const messages = prev.messages;
				const clientMessageId = event.message.clientMessageId;
				if (clientMessageId) {
					const existingIndex = messages.findIndex((message) => message.clientMessageId === clientMessageId);
					if (existingIndex >= 0) {
						const next = messages.slice();
						next[existingIndex] = { ...next[existingIndex], pending: false };
						return { ...prev, messages: next };
					}
				}
				const last = messages[messages.length - 1];
				if (last && last.role === "user") {
					const a = { text: last.content, images: last.images ?? [] };
					const b = normalizeUserContent(event.message.content);
					if (a.text === b.text && a.images.length === b.images.length) return prev;
				}
				const normalized = normalizeUserContent(event.message.content);
				return {
					...prev,
					messages: [
						...messages,
						{
							role: "user",
							content: normalized.text,
							...(normalized.images.length ? { images: normalized.images } : {}),
							...(clientMessageId ? { clientMessageId } : {}),
						},
					],
				};
			});
			break;
		}
		case "status": {
			const isRunning = event.status === "running";
			setRunning(isRunning);
			setSession((prev) =>
				prev
					? {
							...prev,
							status: event.status,
							turnStartedAt: isRunning ? (event.startedAt ?? prev.turnStartedAt) : null,
						}
					: prev,
			);
			wasRunningRef.current = isRunning;
			break;
		}
		case "token":
			updateStreaming({ type: "content", text: event.text });
			setSession((prev) => {
				if (!prev) return prev;
				const messages = stripRetryRow(prev.messages);
				return messages === prev.messages ? prev : { ...prev, messages };
			});
			break;
		case "thinking":
			updateStreaming({ type: "thinking", text: event.text });
			setSession((prev) => {
				if (!prev) return prev;
				const messages = stripRetryRow(prev.messages);
				return messages === prev.messages ? prev : { ...prev, messages };
			});
			break;
		case "retry":
			setSession((prev) =>
				prev
					? {
							...prev,
							messages: upsertRetryRow(prev.messages, `[Retrying (attempt ${event.attempt}): ${event.reason}]`),
						}
					: prev,
			);
			break;
		case "tool_start":
			updateStreaming({
				type: "tool_start",
				call: { id: event.id, name: event.name, args: event.args, status: event.status },
			});
			setSession((prev) => {
				if (!prev) return prev;
				const messages = stripRetryRow(prev.messages);
				return messages === prev.messages ? prev : { ...prev, messages };
			});
			break;
		case "tool_end":
			updateStreaming({
				type: "tool_end",
				id: event.id,
				status: event.status,
				result: event.result?.content ?? "",
				...(event.result?.imageDataUrl ? { images: [event.result.imageDataUrl] } : {}),
			});
			// Only file-modifying tools should invalidate the Files cache — otherwise
			// every tool (read, grep, etc.) would make open folders flicker on each
			// tool_end while the user is browsing.
			const fileTools = new Set(["write", "edit", "bash", "apply_patch", "task"]);
			if (fileTools.has(event.name)) {
				if (diffOpenRef.current) queueDiffRefresh();
				else setFsRefreshNonce((n) => n + 1);
			}
			if (!event.result?.isError && event.name === "plan_done") {
				const transition = { kind: "done", sessionId: streamSessionId };
				pendingPlanSignalRef.current = transition;
				setSession((prev) => (prev ? { ...prev, planTransition: transition } : prev));
			}
			if (!event.result?.isError && event.name === "question") {
				try {
					const question = JSON.parse(event.result.content);
					if (Array.isArray(question.questions) && question.questions.length > 0) {
						setSession((prev) => (prev ? { ...prev, question } : prev));
					}
				} catch {
					// Keep malformed tool output in the transcript without opening a picker.
				}
			}
			break;
		case "assistant_message": {
			const previousStreaming = takeStreamingNow();
			setSession((prev) => {
				if (!prev) return prev;
				if (previousStreaming.length > 0) {
					return { ...prev, messages: [...prev.messages, { role: "assistant", blocks: previousStreaming }] };
				}
				const blocks = blocksFromAssistantCompletion(event);
				return blocks.length === 0
					? prev
					: { ...prev, messages: [...prev.messages, { role: "assistant", blocks }] };
			});
			break;
		}
		case "end": {
			const wasRunning = wasRunningRef.current;
			resetStreamingNow();
			setRunning(false);
			setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
			setPendingSteers([]);
			setPendingQueue([]);
			if (pendingPlanSignalRef.current?.sessionId === streamSessionId) {
				setPlanTransition(pendingPlanSignalRef.current);
				pendingPlanSignalRef.current = null;
			}
			if (wasRunning) {
				try {
					if (document.hidden && typeof Notification !== "undefined") {
						if (Notification.permission === "granted") new Notification("Cast — turn done", { body: "Agent finished", icon: "/favicon.svg" });
						else if (Notification.permission !== "denied") Notification.requestPermission().catch(()=>{});
					}
				} catch {}
				try {
					// Only when the tab isn't in front, same as the notification
					// above — the beep exists to say "look over here", and it fired
					// even while the user was watching the turn happen.
					// One shared AudioContext: a fresh one per turn accumulates
					// against the browser's per-page limit, after which later
					// beeps silently fail.
					if (document.hidden) playTurnDoneChime();
				} catch {}
			}
			break;
		}
		case "turn_meta":
			setSession((prev) => {
				if (!prev || prev.messages.length === 0) return prev;
				const messages = prev.messages.slice();
				const index = messages.length - 1;
				messages[index] = {
					...messages[index],
					turnMeta: { provider: event.provider, model: event.model, totalMs: event.totalMs },
				};
				return { ...prev, messages };
			});
			break;
		case "session_end":
			setSession((prev) => {
				if (!prev) return prev;
				if (event.messageCount === prev.messages.length) return { ...prev, usage: event.usage };
				api("GET", `/api/sessions/${streamSessionId}`)
					.then((data) => {
						if (!data || !isCurrent()) return;
						setSession((inner) =>
							!inner || inner.id !== streamSessionId
								? inner
								: {
										...inner,
										messages: mergeHistoryPage(inner.messages, data.messages || []),
										usage: data.usage,
										updatedAt: data.updatedAt,
									},
						);
					})
					.catch(() => {});
				return { ...prev, usage: event.usage };
			});
			break;
		case "plan_decision":
			setSession((prev) =>
				prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: event.content }] } : prev,
			);
			break;
		case "decision_state":
			// The daemon owns planState: any pending question (a model `question`
			// call or the post-turn skill-save confirmation) arrives here as well
			// as through the tool_end path — keep session.question in lockstep so
			// the QuestionCard renders for both. A clear (undefined) closes it.
			setSession((prev) => (prev ? { ...prev, question: event.question ?? undefined } : prev));
			break;
		case "notice":
			setSession((prev) =>
				prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: event.message }] } : prev,
			);
			break;
		case "agent_actor": {
			const actor = event.actor;
			const status = actor.status === "success" ? "completed" : actor.status;
			setSession((prev) =>
				prev
					? { ...prev, messages: [...prev.messages, { role: "warning", content: `${actor.agent} ${status}` }] }
					: prev,
			);
			break;
		}
		case "error":
			resetStreamingNow();
			setRunning(false);
			setSession((prev) =>
				prev
					? {
							...prev,
							status: "error",
							messages: [...prev.messages, { role: "error", content: event.message ?? "Unknown error" }],
						}
					: prev,
			);
			break;
		case "session_update":
			setSessions((prev) =>
				prev.map((session) => (session.id === event.session.id ? { ...session, ...event.session } : session)),
			);
			break;
		case "fs_change":
			// External edit (IDE, CI hook, etc.) on the session cwd while it
			// was idle. Pick it up in Changes + Files tree; the panel's own
			// open-on-open effect already handles the diff tab if it's mounted.
			queueDiffRefresh();
			setFsRefreshNonce((n) => n + 1);
			break;
		case "compaction":
			setSession((prev) =>
				prev
					? {
							...prev,
							messages: [
								...prev.messages,
								{ role: "system", content: `Context compacted (${event.messagesCompacted} messages)` },
							],
						}
					: prev,
			);
			break;
		case "doom_loop":
			setSession((prev) =>
				prev
					? {
							...prev,
							messages: [
								...prev.messages,
								{ role: "warning", content: `Doom loop: ${event.tool} called ${event.attempts} times` },
							],
						}
					: prev,
			);
			break;
		case "steering_injected":
		case "followup_injected": {
			const previousStreaming = takeStreamingNow();
			setSession((prev) => {
				if (!prev) return prev;
				const messages =
					previousStreaming.length > 0
						? [...prev.messages, { role: "assistant", blocks: previousStreaming }]
						: prev.messages;
				const injected = event.messages
					.filter(
						(message) =>
							!message.castClientMessageId ||
								!messages.some(
									(existing) =>
										existing.clientMessageId ===
											message.castClientMessageId,
								),
					)
					.map((message) => ({
						role: "user",
						content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
						...(message.castClientMessageId
							? { clientMessageId: message.castClientMessageId }
							: {}),
					}));
				return { ...prev, messages: [...messages, ...injected] };
			});
			if (event.type === "steering_injected") setPendingSteers((previous) => previous.slice(event.messages.length));
			else setPendingQueue((previous) => previous.slice(event.messages.length));
			break;
		}
		case "interrupt_reminder":
			setSession((prev) =>
				prev
					? {
							...prev,
							messages: [...prev.messages, { role: "warning", content: "Context restored after interrupt" }],
						}
					: prev,
			);
			break;
		case "date_rollover":
			setSession((prev) =>
				prev
					? {
							...prev,
							messages: [...prev.messages, { role: "warning", content: `Date rolled over to ${event.date}` }],
						}
					: prev,
			);
			break;
		case "open_work_gate":
			addNotice(`Plan steps still open — continuing (attempt ${event.fires})`);
			break;
		case "open_work_gate_exhausted":
			addNotice("Plan steps still open — max retries reached, ending turn");
			break;
		case "session_closed":
			if (selfClosingRef.current === activeId) selfClosingRef.current = null;
			else showToast("This session was closed", "error");
			break;
	}
}
