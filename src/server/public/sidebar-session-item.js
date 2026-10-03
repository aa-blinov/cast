import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { icons } from "./icons.js";
import { sessionLabel, sessionMeta } from "./sidebar-utils.js";

const html = htm.bind(h);

// The draft lives here, not in the sidebar: a keystroke would otherwise re-render every row of the history.
function RenameInput({ inputRef, initial, onCommit, onCancel }) {
	const [value, setValue] = useState(initial);
	return html`<input ref=${inputRef} class="sidebar-item-name-input" aria-label="Session name" value=${value} onClick=${(e) => e.stopPropagation()} onInput=${(e) => setValue(e.target.value)} onKeyDown=${(
		e,
	) => {
		if (e.key === "Enter") {
			e.preventDefault();
			onCommit(value);
		}
		if (e.key === "Escape") {
			e.preventDefault();
			onCancel();
		}
	}} onBlur=${() => onCommit(value)} />`;
}

export function SidebarSessionItem({
	session,
	activeId,
	selectingId,
	selecting,
	onSelect,
	onPin,
	editingId,
	editInputRef,
	commitEdit,
	cancelEdit,
	startEdit,
	menuFor,
	openMenu,
}) {
	const s = session;
	// `selecting` is true while the click's /api/sessions/:id fetch is still
	// in flight (activeId only flips when the response lands). The row gets
	// the same "active" highlight up front so the click reads as registered
	// immediately; the actual loader is shown in the chat area — that
	// matches the existing empty-state spinner style and keeps the sidebar
	// visual language simple (just selected / not selected).
	//
	// Mutual exclusion: when transitioning from active session A to selecting
	// session B, both `s.id === activeId` (row A) and `selecting` (row B)
	// would resolve true under the old `||` — the user would see two rows
	// highlighted at once. While ANY selecting is in flight, only the
	// selecting row lights up; the activeId row goes dark (it'll re-light
	// the moment selectingId clears). Pass selectingId (not just the
	// selecting boolean) so we can tell "is this row the picker target?"
	// from "is some other row the picker target?".
	const isActive = selecting || (s.id === activeId && !selectingId);
	const menuOpen = menuFor === s.id;
	return html`
		<div
			key=${s.id}
			class="sidebar-item${isActive ? " active" : ""}${menuOpen ? " menu-open" : ""}"
			title=${s.cwd}
			onClick=${() => onSelect(s.id)}
			onContextMenu=${(e) => {
				e.preventDefault();
				e.stopPropagation();
				openMenu(s.id, e.currentTarget);
			}}
		>
			<span class="sidebar-item-status ${s.status || "idle"}" aria-hidden="true" />
			<button type="button" class="sidebar-item-pin${s.pinned ? " pinned" : ""}" title=${s.pinned ? "Unpin" : "Pin to top"} aria-label=${s.pinned ? "Unpin" : "Pin to top"} aria-pressed=${Boolean(s.pinned)} onClick=${(
				e,
			) => {
				e.stopPropagation();
				onPin(s.id, !s.pinned);
			}}>
				<${icons.bookmark} />
			</button>
			${
				editingId === s.id
					? html`<${RenameInput} inputRef=${editInputRef} initial=${s.title || ""} onCommit=${commitEdit} onCancel=${cancelEdit} />`
					: html`<button type="button" class="sidebar-item-text" aria-current=${isActive ? "true" : undefined} onDblClick=${(e) => {
							e.stopPropagation();
							startEdit(s);
						}}><span class="sidebar-item-name">${sessionLabel(s)}</span><span class="sidebar-item-meta">${sessionMeta(s)}</span></button>`
			}
			<div class="sidebar-item-menu-anchor">
				<button class="sidebar-item-more" title="More" aria-label="More" aria-haspopup="menu" aria-expanded=${menuOpen} onClick=${(e) => {
					e.stopPropagation();
					openMenu(menuFor === s.id ? null : s.id, e.currentTarget.closest(".sidebar-item"));
				}}><${icons.ellipsisVertical} /></button>
			</div>
		</div>
	`;
}
