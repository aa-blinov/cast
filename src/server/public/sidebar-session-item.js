import htm from "htm";
import { h } from "preact";
import { icons } from "./icons.js";

const html = htm.bind(h);

export function SidebarSessionItem({
	session,
	activeId,
	selectingId,
	selecting,
	onSelect,
	onPin,
	editingId,
	editInputRef,
	editValue,
	setEditValue,
	commitEdit,
	cancelEdit,
	startEdit,
	menuFor,
	menuUpward,
	openMenu,
	setMenuFor,
	onShare,
	onFork,
	onDelete,
}) {
	const s = session;
	const doDelete = () => onDelete(s);
	const doFork = () => onFork(s.id);
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
	return html`
		<div
			key=${s.id}
			class="sidebar-item${isActive ? " active" : ""}"
			title=${s.cwd}
			onClick=${() => onSelect(s.id)}
			onContextMenu=${(e) => {
				e.preventDefault();
				e.stopPropagation();
				openMenu(s.id, e.currentTarget);
			}}
		>
			<span class="sidebar-item-status ${s.status || "idle"}" />
			<button class="sidebar-item-pin${s.pinned ? " pinned" : ""}" title=${s.pinned ? "Unpin" : "Pin to top"} onClick=${(
				e,
			) => {
				e.stopPropagation();
				onPin(s.id, !s.pinned);
			}}>
				<${icons.bookmark} />
			</button>
			${
				editingId === s.id
					? html`<input ref=${editInputRef} class="sidebar-item-name-input" value=${editValue} onClick=${(e) => e.stopPropagation()} onInput=${(e) => setEditValue(e.target.value)} onKeyDown=${(
							e,
						) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitEdit();
							}
							if (e.key === "Escape") {
								e.preventDefault();
								cancelEdit();
							}
						}} onBlur=${commitEdit} />`
					: html`<span class="sidebar-item-name" onDblClick=${(e) => {
							e.stopPropagation();
							startEdit(s);
						}}>${s.title || s.persona || "unknown"}</span>`
			}
			<div class="sidebar-item-menu-anchor">
				<button class="sidebar-item-more" title="More" aria-label="More" onClick=${(e) => {
					e.stopPropagation();
					openMenu(menuFor === s.id ? null : s.id, e.currentTarget.closest(".sidebar-item"));
				}}><${icons.ellipsisVertical} /></button>
				${
					menuFor === s.id &&
					html`
					<div class="sidebar-item-menu${menuUpward ? " upward" : ""}" onClick=${(e) => e.stopPropagation()}>
						<button class="sidebar-item-menu-item" onClick=${() => {
							setMenuFor(null);
							startEdit(s);
						}}><${icons.pencil} /> Rename</button>
						<button class="sidebar-item-menu-item" onClick=${() => {
							setMenuFor(null);
							onShare(s);
						}}><${icons.link} /> Share</button>
						<button class="sidebar-item-menu-item" disabled=${s.status === "running"} title=${s.status === "running" ? "Wait for the agent to finish" : "Create a new session from this context"} onClick=${() => {
							setMenuFor(null);
							doFork();
						}}><${icons.fork} /> Fork</button>
						<button class="sidebar-item-menu-item danger" onClick=${() => {
							setMenuFor(null);
							doDelete();
						}}><${icons.trash} /> Delete</button>
					</div>`
				}
			</div>
		</div>
	`;
}
