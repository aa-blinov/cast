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
			break;
		case "thinking":
			updateStreaming({ type: "thinking", text: event.text });
			break;
		case "tool_start":
			updateStreaming({
				type: "tool_start",
				call: { id: event.id, name: event.name, args: event.args, status: event.status },
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
			if (diffOpenRef.current) queueDiffRefresh();
			if (!event.result?.isError && event.name === "plan_done") {
				const transition = { kind: "done", sessionId: streamSessionId };
				pendingPlanSignalRef.current = transition;
				setSession((prev) => (prev ? { ...prev, planTransition: transition } : prev));
			}
			if (!event.result?.isError && event.name === "question") {
				try {
					const question = JSON.parse(event.result.content);
					if (question.question) setSession((prev) => (prev ? { ...prev, question } : prev));
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
		case "end":
			resetStreamingNow();
			setRunning(false);
			setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
			setPendingSteers([]);
			setPendingQueue([]);
			if (pendingPlanSignalRef.current?.sessionId === streamSessionId) {
				setPlanTransition(pendingPlanSignalRef.current);
				pendingPlanSignalRef.current = null;
			}
			break;
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
				const injected = event.messages.map((message) => ({
					role: "user",
					content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
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
