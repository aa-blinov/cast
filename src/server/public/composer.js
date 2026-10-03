import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import {
	isBlockedAttachmentName,
	partitionFiles,
	readFileAsDataUrl,
	resizeImageToDataUrl,
} from "./composer-attachments.js";
import { CommandPalette, PICKER_LIST_ID, pickerOptionId, ValueSuggest } from "./composer-pickers.js";
import { icons } from "./icons.js";
import { MAX_VOICE_SECONDS, startVoiceRecording, voiceUnavailableReason } from "./voice-recorder.js";

const PERSONA_CMD_RE = /^\/persona\s+(\S*)$/i;

/** The `@query` token ending at the caret; `@` must start a word, so an e-mail address doesn't count. Same rule as the TUI. */
// Telling "denied" from "busy" matters: the first is fixed in the browser's site settings, the second by closing another app.
export function voiceErrorMessage(error) {
	switch (error?.name) {
		case "NotFoundError":
			return "No microphone found";
		case "NotAllowedError":
		case "SecurityError":
			return "Microphone access was denied";
		case "NotReadableError":
			return "The microphone is in use by another app";
		default:
			return error?.message || "Could not start recording";
	}
}

export function atTokenAt(value, caret) {
	let from = caret;
	while (from > 0 && !/\s/.test(value[from - 1])) from--;
	if (value[from] !== "@") return null;
	return { from, to: caret, query: value.slice(from + 1, caret) };
}

const html = htm.bind(h);

/**
 * Keeps the caret (and with it the on-screen keyboard) in the textarea when a
 * composer button is pressed: the default pointerdown behaviour moves focus to
 * the button, which on a phone closes the keyboard before the tap has even
 * fired its click.
 */
function keepComposerFocus(event) {
	event.preventDefault();
}

/** What to tell the person when images were left out: over the limit, or ones that could not be read. */
export function imageNotice(skipped, limit, failedNames) {
	const parts = [];
	if (skipped > 0) parts.push(`${skipped} image${skipped > 1 ? "s" : ""} left out: up to ${limit} per message`);
	if (failedNames.length > 0) parts.push(`Couldn't read ${failedNames.join(", ")}`);
	return parts.join(". ");
}

export function canSubmitAttachments(docs) {
	return docs.every((doc) => !doc.uploading && !doc.error);
}

export function Composer({
	running,
	aborting = false,
	ready,
	sendReady = true,
	activeId,
	commands,
	personas,
	audioInput = false,
	onSubmit,
	onAbort,
	onDocUploaded,
}) {
	const [value, setValue] = useState("");
	const [cmdVisible, setCmdVisible] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [images, setImages] = useState([]);
	// Non-image attachments — unlike images (embedded as image_url content
	// parts on send), these upload to ~/.cast/inputs/<session-id>/ the moment
	// they're attached (see inputs.ts / server.ts's upload route), so the
	// composer just tracks {id, name, path, uploading, error} for each and
	// references the already-on-disk path via a <system-reminder> at send time.
	const [docs, setDocs] = useState([]);
	// A recorded voice note ({ dataUrl, seconds }), sent as one more data: URL
	// beside the images; only offered when the session's model hears audio.
	const [voice, setVoice] = useState(null);
	const [recordingSince, setRecordingSince] = useState(null);
	const [voiceStatus, setVoiceStatus] = useState(null);
	const recorderRef = useRef(null);
	const [, setTick] = useState(0);
	const [dragOver, setDragOver] = useState(false);
	// Said once, then it goes: why a file or image did not make it into the message.
	const [notice, setNotice] = useState(null);
	const noticeTimerRef = useRef(null);
	const showNotice = useCallback((message) => {
		clearTimeout(noticeTimerRef.current);
		setNotice(message || null);
		if (message) noticeTimerRef.current = setTimeout(() => setNotice(null), 8000);
	}, []);
	useEffect(() => () => clearTimeout(noticeTimerRef.current), []);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);
	const fileInputRef = useRef(null);

	// Docs and images are per-session — switching sessions must drop
	// any attachments the user added while viewing a different session.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId is a prop that changes on session switch
	useEffect(() => {
		setDocs([]);
		setImages([]);
		setVoice(null);
		recorderRef.current?.cancel();
		recorderRef.current = null;
		setRecordingSince(null);
	}, [activeId]);

	// Re-render once a second while recording, for the elapsed-time label.
	useEffect(() => {
		if (recordingSince === null) return;
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [recordingSince]);

	const finishRecording = useCallback(async () => {
		const recorder = recorderRef.current;
		if (!recorder) return;
		recorderRef.current = null;
		setRecordingSince(null);
		setVoiceStatus("Preparing voice note…");
		try {
			setVoice(await recorder.stop());
			setVoiceStatus(null);
		} catch {
			setVoiceStatus("Couldn't read the recording");
		}
	}, []);

	const toggleRecording = useCallback(async () => {
		if (recorderRef.current) return finishRecording();
		setVoiceStatus(null);
		try {
			recorderRef.current = await startVoiceRecording({ onLimit: () => void finishRecording() });
			setVoice(null);
			setRecordingSince(Date.now());
		} catch (error) {
			recorderRef.current = null;
			setVoiceStatus(voiceErrorMessage(error));
		}
	}, [finishRecording]);

	const cancelRecording = useCallback(() => {
		recorderRef.current?.cancel();
		recorderRef.current = null;
		setRecordingSince(null);
	}, []);

	const MAX_IMAGES = 6;
	// A rewind returns the removed message here, but never over what the person is already typing.
	useEffect(() => {
		const onDraft = (e) => {
			setValue((current) => (current.trim() ? current : String(e.detail?.text ?? "")));
			textareaRef.current?.focus();
		};
		window.addEventListener("cast:set-draft", onDraft);
		return () => window.removeEventListener("cast:set-draft", onDraft);
	}, []);
	const [resizingImages, setResizingImages] = useState(0);
	const addImageFiles = useCallback(async (files) => {
		if (files.length === 0) return;
		// Enforce server limit client-side with immediate feedback
		const allowed = Math.max(0, MAX_IMAGES - images.length - resizingImages);
		const sliced = files.slice(0, allowed);
		const failed = [];
		showNotice(imageNotice(files.length - sliced.length, MAX_IMAGES, []));
		if (sliced.length === 0) return;
		setResizingImages((n) => n + sliced.length);
		const resized = await Promise.all(
			sliced.map((f) =>
				resizeImageToDataUrl(f).catch(() => {
					failed.push(f.name);
					return null;
				}),
			),
		);
		setImages((prev) => [...prev, ...resized.filter(Boolean).slice(0, MAX_IMAGES - prev.length)]);
		setResizingImages((n) => Math.max(0, n - sliced.length));
		if (failed.length > 0) showNotice(imageNotice(files.length - sliced.length, MAX_IMAGES, failed));
	}, [images.length, resizingImages, showNotice]);

	const addDocFiles = useCallback(
		async (files) => {
			if (files.length === 0) return;
			for (const file of files) {
				const id = `${file.name}-${Date.now()}-${Math.random()}`;
				if (isBlockedAttachmentName(file.name)) {
					setDocs((prev) => [
						...prev,
						{ id, name: file.name, error: "Executable/binary files aren't accepted as attachments" },
					]);
					continue;
				}
				// Draft sessions have no server-side session yet — defer the
				// actual upload until the compose sends (submitMessage handles
				// it after commitSession creates the real session). Store the
				// dataUrl so the composer can show the file is ready.
				if (!activeId) {
					try {
						// biome-ignore lint/performance/noAwaitInLoops: sequential upload for per-file feedback
						const dataUrl = await readFileAsDataUrl(file);
						setDocs((prev) => [...prev, { id, name: file.name, dataUrl, pending: true }]);
					} catch (err) {
						setDocs((prev) => [...prev, { id, name: file.name, error: err.message }]);
					}
					continue;
				}
				setDocs((prev) => [...prev, { id, name: file.name, uploading: true }]);
				try {
					const dataUrl = await readFileAsDataUrl(file);
					const result = await api("POST", `/api/sessions/${activeId}/inputs/upload`, {
						name: file.name,
						dataUrl,
					});
					setDocs((prev) =>
						prev.map((d) => (d.id === id ? { id, name: result.name, path: result.path, size: result.size } : d)),
					);
					onDocUploaded?.();
				} catch (err) {
					setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, uploading: false, error: err.message } : d)));
				}
			}
		},
		[activeId, onDocUploaded],
	);

	const removeDoc = useCallback(
		(doc) => {
			setDocs((prev) => prev.filter((d) => d.id !== doc.id));
			// A pending doc (draft session) was never uploaded — nothing to
			// clean up server-side. Only DELETE real, already-on-disk files.
			if (activeId && doc.path) {
				api("DELETE", `/api/sessions/${activeId}/inputs?path=${encodeURIComponent(doc.name)}`).catch(() => {});
			}
		},
		[activeId],
	);

	const handlePaste = useCallback(
		(e) => {
			const files = Array.from(e.clipboardData?.items ?? [])
				.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter(Boolean);
			if (files.length === 0) return; // let normal text paste proceed
			e.preventDefault();
			addImageFiles(files);
		},
		[addImageFiles],
	);

	const handleDrop = useCallback(
		(e) => {
			e.preventDefault();
			setDragOver(false);
			const { images: imageFiles, docs: docFiles } = partitionFiles(e.dataTransfer?.files);
			addImageFiles(imageFiles);
			addDocFiles(docFiles);
		},
		[addImageFiles, addDocFiles],
	);

	const handleFilePick = useCallback(
		(e) => {
			const { images: imageFiles, docs: docFiles } = partitionFiles(e.target.files);
			addImageFiles(imageFiles);
			addDocFiles(docFiles);
			e.target.value = ""; // same file picked twice in a row must still fire onChange
		},
		[addImageFiles, addDocFiles],
	);

	// Only /persona still lives in the composer — model, theme, reasoning,
	// web-tools, MCP/skills/provider/SSH, and the rest of the former
	// sub-arg pickers moved to the Settings modal (see SettingsModal) so
	// typing "/" only ever surfaces conversation-flow commands.
	const personaMatch = PERSONA_CMD_RE.exec(value);

	const resizeRafRef = useRef(null);
	const resize = useCallback(() => {
		if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
		resizeRafRef.current = requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.style.height = "auto";
				el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
			}
		});
	}, []);
	useEffect(() => () => { if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current); }, []);

	const [sending, setSending] = useState(false);
	const handleSubmit = useCallback(() => {
		// `sendReady` (the daemon connection) is deliberately not a gate here:
		// submitMessage asks for a reconnect and waits a few seconds, which
		// beats a tap that does nothing while the page is catching up.
		if (!ready || sending) return;
		if (!canSubmitAttachments(docs)) return;
		const trimmed = value.trim();
		const readyDocs = docs.filter((d) => (d.path || d.pending) && !d.uploading && !d.error);
		const pendingDocs = docs.filter((d) => d.pending && d.dataUrl);
		// A caption-less image/document send is allowed — an attachment alone
		// is a complete message, same as any chat app.
		if (recordingSince !== null) return;
		if (!trimmed && images.length === 0 && readyDocs.length === 0 && !voice) return;
		// Invisible to the user (toDisplayMessages strips <system-reminder>
		// blocks and shows them as a separate "[system] ..." notice instead of
		// leaving them in the message bubble) — the model gets the absolute
		// path so it can `read`/`bash` (or a format-specific skill) the file
		// itself; nothing here parses the attachment's actual content.
		const text =
			readyDocs.length > 0
				? `${trimmed}\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n${readyDocs.map((d) => `- ${d.name}: ${d.path ?? `(pending — will be uploaded on send)`}`).join("\n")}\n</system-reminder>`
				: trimmed;
		// Snapshot to restore only if submit explicitly reports failure (e.g. connection lost before SSE ready)
		const snapshot = { value, images: [...images], docs: [...docs], voice };
		// Optimistic clear — feels instant, no "Sending…" hang. Not while the
		// daemon connection is down, though: that submit waits for a reconnect,
		// and emptying the box for those seconds looks like the message went
		// somewhere. It clears when the send actually goes out.
		const clearDraft = () => {
			setValue("");
			setImages([]);
			setDocs([]);
			setVoice(null);
		};
		if (sendReady) clearDraft();
		setCmdVisible(false);
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			// Synchronously, inside the tap/keypress that submitted: a mobile
			// browser only keeps (or re-opens) the on-screen keyboard for a
			// focus call made during a user gesture. This used to happen after
			// onSubmit resolved, so the keyboard slid away on send and then
			// jumped back up mid-request.
			textareaRef.current.focus();
		}
		setSending(true);
		// Brief debounce to prevent double-Enter spam, not tied to network —
		// except while the connection is down, where the submit waits for a
		// reconnect and releasing the button early would send it twice.
		if (sendReady) setTimeout(() => setSending(false), 400);
		const attachments = voice ? [...images, voice.dataUrl] : images;
		Promise.resolve(onSubmit(text, attachments, pendingDocs.length > 0 ? pendingDocs : undefined))
			.finally(() => {
				if (!sendReady) setSending(false);
			})
			.then((result) => {
				if (result !== false && !sendReady) clearDraft();
				if (result === false) {
					// Restore only if user hasn't already typed something new
					setValue((prev) => (prev ? prev : snapshot.value));
					setImages((prev) => (prev.length ? prev : snapshot.images));
					setDocs((prev) => (prev.length ? prev : snapshot.docs));
					setVoice((prev) => prev ?? snapshot.voice);
					requestAnimationFrame(() => {
						if (textareaRef.current) {
							textareaRef.current.focus();
							textareaRef.current.style.height = "auto";
							textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
						}
					});
				}
			})
			.catch(() => {
				setValue((prev) => (prev ? prev : snapshot.value));
				setImages((prev) => (prev.length ? prev : snapshot.images));
				setDocs((prev) => (prev.length ? prev : snapshot.docs));
				setVoice((prev) => prev ?? snapshot.voice);
			});
	}, [value, images, docs, voice, recordingSince, onSubmit, ready, sendReady, sending]);

	const handleCmdSelect = useCallback(
		async (name) => {
			if (!ready || !sendReady) return;
			// Argument-less commands (help, current, usage, ...) should just run —
			// filling the box with "/current " and waiting for a second Enter is
			// exactly the "picker doesn't work" feeling this is meant to fix.
			const cmd = commands.find((c) => c.name === name);
			if (cmd && !cmd.takesArgs) {
				setValue("");
				setCmdVisible(false);
				if (textareaRef.current) textareaRef.current.style.height = "auto";
				await onSubmit(name);
				return;
			}
			setValue(`${name} `);
			setCmdVisible(false);
			textareaRef.current?.focus();
			requestAnimationFrame(resize);
		},
		[commands, onSubmit, resize, ready, sendReady],
	);

	const handlePersonaSelect = useCallback(
		async (name) => {
			if (!ready || !sendReady) return;
			setValue("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
			await onSubmit(`/persona ${name}`);
		},
		[onSubmit, ready, sendReady],
	);

	// `@path` picker: the token under the caret, and the project files matching
	// it (fetched from the daemon, newest answer wins).
	const [atTokenState, setAtToken] = useState(null);
	// Only while the text still holds it: a send or an edit elsewhere drops it.
	const atToken =
		atTokenState && value.slice(atTokenState.from, atTokenState.to) === `@${atTokenState.query}` ? atTokenState : null;
	const [atFiles, setAtFiles] = useState([]);
	const atRequestRef = useRef(0);
	useEffect(() => {
		if (!atToken || !activeId) {
			setAtFiles([]);
			return;
		}
		const request = ++atRequestRef.current;
		const timer = setTimeout(() => {
			api("GET", `/api/sessions/${activeId}/fs/files?q=${encodeURIComponent(atToken.query)}`)
				.then((data) => {
					if (request === atRequestRef.current) setAtFiles(Array.isArray(data?.files) ? data.files : []);
				})
				.catch(() => {});
		}, 80);
		return () => clearTimeout(timer);
	}, [atToken?.query, atToken?.from, activeId]);

	const handleAtSelect = useCallback(
		(path) => {
			if (!atToken) return;
			const next = `${value.slice(0, atToken.from)}@${path} ${value.slice(atToken.to)}`;
			const caret = atToken.from + path.length + 2;
			setValue(next);
			setAtToken(null);
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
				textareaRef.current?.setSelectionRange(caret, caret);
			});
		},
		[atToken, value],
	);

	const handleInput = useCallback(
		(e) => {
			const val = e.target.value;
			setValue(val);
			setCmdVisible(val.startsWith("/") && !val.includes(" "));
			setAtToken(val.startsWith("/") ? null : atTokenAt(val, e.target.selectionStart ?? val.length));
			setSelectedIndex(0);
			resize();
		},
		[resize],
	);

	// One active picker at a time — Composer owns the filtered list and the
	// selection index so arrow keys and mouse clicks act on the exact same
	// row order, whichever picker happens to be showing. Persona/model
	// normalize to {value, label} so ValueSuggest can render either the same way.
	let pickerItems = [];
	let pickerSelect = null;
	if (personaMatch) {
		pickerItems = personas
			.filter((p) => p.name.toLowerCase().startsWith(personaMatch[1].toLowerCase()))
			.map((p) => ({ value: p.name, label: p.label }));
		pickerSelect = handlePersonaSelect;
	} else if (cmdVisible) {
		pickerItems = (value ? commands.filter((c) => c.name.startsWith(value)) : commands).filter((c) => !c.hidden);
		pickerSelect = handleCmdSelect;
	} else if (atToken && atFiles.length > 0) {
		pickerItems = atFiles.map((path) => ({ value: path, label: "" }));
		pickerSelect = handleAtSelect;
	}
	const clampedIndex = pickerItems.length > 0 ? Math.min(selectedIndex, pickerItems.length - 1) : 0;
	const pickerOpen = pickerItems.length > 0;
	const attachmentsBlocked = !canSubmitAttachments(docs) || resizingImages > 0;
	const hasReadyDocs = docs.some((d) => (d.path || d.pending) && !d.uploading && !d.error);
	const sendBlocked = !ready || sending || resizingImages > 0 || recordingSince !== null;
	const voiceBlockedReason = audioInput ? voiceUnavailableReason() : null;
	const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

	// Arrow-key nav must scroll the picker, not just select past the visible
	// edge — mouse/scroll-wheel already worked, but the highlighted row could
	// silently move off-screen when reached via the keyboard.
	// biome-ignore lint/correctness/useExhaustiveDependencies: clampedIndex isn't read in the body — it's the trigger to re-scroll to the now-selected row, found via DOM query instead of the value itself.
	useEffect(() => {
		pickerRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	const handleKeyDown = useCallback(
		(e) => {
			// Esc stops a running turn — checked before anything else so it wins
			// regardless of what's in the composer (an open command palette, a
			// half-typed /steer), matching the TUI's Escape-aborts behavior. The
			// hotkeys reference has always listed this; the web port just never
			// actually wired it up until now.
			if (e.key === "Escape" && running) {
				e.preventDefault();
				onAbort();
				return;
			}
			if (pickerItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSelectedIndex((clampedIndex + 1) % pickerItems.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSelectedIndex((clampedIndex - 1 + pickerItems.length) % pickerItems.length);
					return;
				}
				if (e.key === "Escape") {
					setCmdVisible(false);
					setAtToken(null);
					return;
				}
				if (e.key === "Tab" && atToken) {
					e.preventDefault();
					pickerSelect(pickerItems[clampedIndex].value);
					return;
				}
				// Tab completes the text and leaves running it to Enter: a command with no arguments would otherwise run.
				if (e.key === "Tab" && !e.shiftKey && (cmdVisible || personaMatch)) {
					e.preventDefault();
					const item = pickerItems[clampedIndex];
					setValue(personaMatch ? `/persona ${item.value} ` : `${item.name} `);
					setCmdVisible(false);
					resize();
					return;
				}
				if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
					const item = pickerItems[clampedIndex];
					const disabled = item && "blocking" in item && item.blocking && running;
					if (item && !disabled) {
						e.preventDefault();
						pickerSelect(item.value ?? item.name ?? item.id);
						return;
					}
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				handleSubmit();
			}
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: pickerItems/pickerSelect are plain values recomputed every render (not memoized) — already fine since this callback is rebuilt on every keystroke (`value` is a dep) regardless.
		[pickerItems, clampedIndex, pickerSelect, running, handleSubmit, onAbort, atToken, cmdVisible, personaMatch, resize],
	);

	return html`
		<div class="composer-wrap">
			<div ref=${pickerRef}>
				${
					personaMatch || (atToken && !cmdVisible)
						? html`<${ValueSuggest} items=${pickerItems} selectedIndex=${clampedIndex} label=${personaMatch ? "Personas" : "Files"} onHover=${setSelectedIndex} onSelect=${pickerSelect} />`
						: html`<${CommandPalette} items=${pickerItems} selectedIndex=${clampedIndex} running=${running} visible=${cmdVisible} onHover=${setSelectedIndex} onSelect=${handleCmdSelect} />`
				}
			</div>
			${
				resizingImages > 0 &&
				html`<div class="composer-images"><div class="fs-loading" role="status">Resizing ${resizingImages} image${resizingImages > 1 ? "s" : ""}…</div></div>`
			}
			${
				images.length > 0 &&
				html`
				<div class="composer-images">
					${images.map(
						(src, i) => html`
						<div key=${i} class="composer-image-thumb">
							<img src=${src} loading="lazy" alt="Attached image ${i + 1}" />
							<button
								type="button"
								class="composer-image-remove"
								onClick=${() => setImages((prev) => prev.filter((_, j) => j !== i))}
								aria-label="Remove image ${i + 1}"
							><${icons.xMark} /></button>
						</div>
					`,
					)}
				</div>
			`
			}
			${
				(recordingSince !== null || voice || voiceStatus) &&
				html`
				<div class="composer-voice">
					<span class="sr-only" role="status">${recordingSince !== null ? "Recording" : voice ? "Voice message recorded" : voiceStatus}</span>
					${
						recordingSince !== null
							? html`<span class="composer-voice-live" aria-hidden="true">Recording ${clock((Date.now() - recordingSince) / 1000)} / ${clock(MAX_VOICE_SECONDS)}</span>
								<button type="button" class="composer-doc-remove" onClick=${cancelRecording} aria-label="Discard recording"><${icons.xMark} /></button>`
							: voice
								? html`<audio class="composer-voice-player" controls src=${voice.dataUrl}></audio>
									<button type="button" class="composer-doc-remove" onClick=${() => setVoice(null)} aria-label="Remove voice message"><${icons.xMark} /></button>`
								: html`<span class="composer-voice-status" aria-hidden="true">${voiceStatus}</span>`
					}
				</div>
			`
			}
			${notice && html`<div class="composer-notice" role="status">${notice}</div>`}
			${
				docs.length > 0 &&
				html`
				<div class="composer-docs">
					${docs.map(
						(d) => html`
						<div key=${d.id} class="composer-doc-chip${d.error ? " composer-doc-chip-error" : ""}" title=${d.error ?? d.name}>
							<span class="composer-doc-text">
								<span class="composer-doc-name">${d.uploading ? "Uploading… " : ""}${d.name}</span>
								${d.error && html`<span class="composer-doc-error" role="alert">${d.error}</span>`}
							</span>
							<button
								type="button"
								class="composer-doc-remove"
								onClick=${() => removeDoc(d)}
								aria-label="Remove ${d.name}"
							><${icons.xMark} /></button>
						</div>
					`,
					)}
				</div>
			`
			}
			<div
				class="composer${dragOver ? " composer-drag-over" : ""}"
				onDragOver=${(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave=${(e) => {
					if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
				}}
				onDrop=${handleDrop}
			>
				${dragOver && html`<div class="composer-drop-hint" aria-hidden="true">Drop to attach</div>`}
				<input
					ref=${fileInputRef}
					type="file"
					multiple
					style="display:none"
					onChange=${handleFilePick}
				/>
				<button
					type="button"
					class="composer-attach"
					onClick=${() => fileInputRef.current?.click()}
					disabled=${!ready}
					aria-label="Attach image or file"
					title="Attach image or file"
				><${icons.paperclip} /></button>
				${
					audioInput &&
					html`<button
						type="button"
						class="composer-attach composer-mic${recordingSince !== null ? " composer-mic-recording" : ""}"
						onPointerDown=${keepComposerFocus}
						onClick=${toggleRecording}
						disabled=${!ready || Boolean(voiceBlockedReason)}
						aria-pressed=${recordingSince !== null}
						aria-label=${recordingSince !== null ? "Stop recording" : "Record a voice message"}
						title=${voiceBlockedReason ?? (recordingSince !== null ? "Stop recording" : "Record a voice message")}
					><${recordingSince !== null ? icons.stop : icons.microphone} /></button>`
				}
				<textarea
					ref=${textareaRef}
					class="composer-input"
					aria-label="Message"
					spellcheck=${false}
					enterkeyhint="send"
					aria-autocomplete="list"
					aria-controls=${pickerOpen ? PICKER_LIST_ID : undefined}
					aria-activedescendant=${pickerOpen ? pickerOptionId(clampedIndex) : undefined}
					placeholder=${!ready ? "Connecting…" : !sendReady ? "Reconnecting…" : "Type a message…"}
					rows="1"
					disabled=${!ready}
					value=${value}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
					onPaste=${handlePaste}
				/>
				${
						running
						? html`<button class="composer-abort" onPointerDown=${keepComposerFocus} onClick=${onAbort} disabled=${aborting} aria-label=${aborting ? "Aborting…" : "Abort"} title=${aborting ? "Aborting…" : sendReady ? "Abort (Esc)" : "Abort — waiting for connection"} aria-busy=${aborting ? "true" : "false"}><${aborting ? icons.spinner : icons.stop} /></button>`
						: html`<button class="composer-send" onPointerDown=${keepComposerFocus} onClick=${handleSubmit} disabled=${sendBlocked || attachmentsBlocked || (!value.trim() && images.length === 0 && !hasReadyDocs && !voice)} aria-label="Send" title=${attachmentsBlocked ? "Wait for attachments to finish uploading" : !sendReady ? "Waiting for the daemon connection" : sending ? "Sending…" : "Send (Enter)"}><${icons.send} /></button>`
				}
			</div>
		</div>
	`;
}
