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
import { CommandPalette, ValueSuggest } from "./composer-pickers.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

export function Composer({ running, ready, activeId, commands, personas, onSubmit, onAbort, onDocUploaded }) {
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
	const [dragOver, setDragOver] = useState(false);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);
	const fileInputRef = useRef(null);

	// Docs and images are per-session — switching sessions must drop
	// any attachments the user added while viewing a different session.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId is a prop that changes on session switch
	useEffect(() => {
		setDocs([]);
		setImages([]);
	}, [activeId]);

	const addImageFiles = useCallback(async (files) => {
		if (files.length === 0) return;
		const resized = await Promise.all(files.map((f) => resizeImageToDataUrl(f).catch(() => null)));
		setImages((prev) => [...prev, ...resized.filter(Boolean)]);
	}, []);

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
	// web-tools, MCP/skills/plugins/provider/SSH, and the rest of the former
	// sub-arg pickers moved to the Settings modal (see SettingsModal) so
	// typing "/" only ever surfaces conversation-flow commands.
	const personaMatch = /^\/persona\s+(\S*)$/i.exec(value);

	const resize = useCallback(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
		}
	}, []);

	const handleSubmit = useCallback(() => {
		const trimmed = value.trim();
		const readyDocs = docs.filter((d) => (d.path || d.pending) && !d.uploading && !d.error);
		const pendingDocs = docs.filter((d) => d.pending && d.dataUrl);
		// A caption-less image/document send is allowed — an attachment alone
		// is a complete message, same as any chat app.
		if (!trimmed && images.length === 0 && readyDocs.length === 0) return;
		// Invisible to the user (toDisplayMessages strips <system-reminder>
		// blocks and shows them as a separate "[system] ..." notice instead of
		// leaving them in the message bubble) — the model gets the absolute
		// path so it can `read`/`bash` (or a format-specific skill) the file
		// itself; nothing here parses the attachment's actual content.
		const text =
			readyDocs.length > 0
				? `${trimmed}\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n${readyDocs.map((d) => `- ${d.name}: ${d.path ?? `(pending — will be uploaded on send)`}`).join("\n")}\n</system-reminder>`
				: trimmed;
		onSubmit(text, images, pendingDocs.length > 0 ? pendingDocs : undefined);
		setValue("");
		setImages([]);
		setDocs([]);
		setCmdVisible(false);
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [value, images, docs, onSubmit]);

	const handleCmdSelect = useCallback(
		(name) => {
			// Argument-less commands (help, current, usage, ...) should just run —
			// filling the box with "/current " and waiting for a second Enter is
			// exactly the "picker doesn't work" feeling this is meant to fix.
			const cmd = commands.find((c) => c.name === name);
			if (cmd && !cmd.takesArgs) {
				onSubmit(name);
				setValue("");
				setCmdVisible(false);
				if (textareaRef.current) textareaRef.current.style.height = "auto";
				return;
			}
			setValue(`${name} `);
			setCmdVisible(false);
			textareaRef.current?.focus();
			requestAnimationFrame(resize);
		},
		[commands, onSubmit, resize],
	);

	const handlePersonaSelect = useCallback(
		(name) => {
			onSubmit(`/persona ${name}`);
			setValue("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
		},
		[onSubmit],
	);

	const handleInput = useCallback(
		(e) => {
			const val = e.target.value;
			setValue(val);
			setCmdVisible(val.startsWith("/") && !val.includes(" "));
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
	}
	const clampedIndex = pickerItems.length > 0 ? Math.min(selectedIndex, pickerItems.length - 1) : 0;

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
		[pickerItems, clampedIndex, pickerSelect, running, handleSubmit, onAbort],
	);

	return html`
		<div class="composer-wrap">
			<div ref=${pickerRef}>
				${
					personaMatch
						? html`<${ValueSuggest} items=${pickerItems} selectedIndex=${clampedIndex} onHover=${setSelectedIndex} onSelect=${pickerSelect} />`
						: html`<${CommandPalette} items=${pickerItems} selectedIndex=${clampedIndex} running=${running} visible=${cmdVisible} onHover=${setSelectedIndex} onSelect=${handleCmdSelect} />`
				}
			</div>
			${
				images.length > 0 &&
				html`
				<div class="composer-images">
					${images.map(
						(src, i) => html`
						<div key=${i} class="composer-image-thumb">
							<img src=${src} />
							<button
								type="button"
								class="composer-image-remove"
								onClick=${() => setImages((prev) => prev.filter((_, j) => j !== i))}
								aria-label="Remove image"
							><${icons.xMark} /></button>
						</div>
					`,
					)}
				</div>
			`
			}
			${
				docs.length > 0 &&
				html`
				<div class="composer-docs">
					${docs.map(
						(d) => html`
						<div key=${d.id} class="composer-doc-chip${d.error ? " composer-doc-chip-error" : ""}" title=${d.error ?? d.name}>
							<span class="composer-doc-name">${d.uploading ? "Uploading… " : ""}${d.name}</span>
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
				onDragLeave=${() => setDragOver(false)}
				onDrop=${handleDrop}
			>
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
				<textarea
					ref=${textareaRef}
					class="composer-input"
					placeholder=${!ready ? "Connecting…" : pickerItems.length > 0 ? "↑↓ to navigate, Enter to pick" : "Type a message or / for commands..."}
					rows="1"
					disabled=${!ready}
					value=${value}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
					onPaste=${handlePaste}
				/>
				${
					running
						? html`<button class="composer-abort" onClick=${onAbort} aria-label="Abort"><${icons.stop} /></button>`
						: html`<button class="composer-send" onClick=${handleSubmit} disabled=${!ready || (!value.trim() && images.length === 0)} aria-label="Send"><${icons.send} /></button>`
				}
			</div>
		</div>
	`;
}
