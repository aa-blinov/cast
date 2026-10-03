import { useEffect, useRef } from "preact/hooks";

export const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Stack of modals currently listening for Escape. Last-in/first-out: when
// two modals are open at once (e.g. NewSessionModal with a DirectoryBrowser
// on top), the topmost one closes first; a second Esc closes the one below.
// Each `useModalFocusTrap` push/pops its own entry, so order matches the
// Preact render order without any explicit z-index bookkeeping.
const escStack = [];

// Bubble phase, so a field inside the modal that uses Escape for itself
// (inline rename, "new folder" row) handles it first and opts out with
// preventDefault. Stopping propagation keeps the per-modal window listeners
// from also closing whatever sits underneath.
function onStackEscape(e) {
	if (e.key !== "Escape" || e.defaultPrevented || escStack.length === 0) return;
	if (escStack[escStack.length - 1]()) e.stopPropagation();
}

// Shared by every modal: move focus into the dialog, keep Tab inside it,
// handle Escape, and restore the triggering element when the dialog closes.
export function useModalFocusTrap(active, initialFocusSelector) {
	const ref = useRef(null);
	useEffect(() => {
		if (!active) return;
		const container = ref.current;
		const previouslyFocused = document.activeElement;
		(
			(initialFocusSelector && container?.querySelector(initialFocusSelector)) ||
			container?.querySelector(FOCUSABLE_SELECTOR) ||
			container
		)?.focus();

		const onKeyDown = (e) => {
			if (e.key !== "Tab" || !container) return;
			const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		// Register an Esc handler that closes this specific modal. Only the
		// top of the stack answers, so the topmost modal always closes first;
		// the rest stays in the stack until their own Esc arrives.
		const onEsc = () => {
			// Best-effort: each modal ships a `.modal-close` button in its
			// header (cast convention; see directory-browser.js, share-modal.js,
			// settings-modal.js, new-session-modal.js). Synthesising a click
			// here means we don't have to thread an `onClose` ref through
			// the focus-trap hook — every modal that opts into the trap gets
			// Escape handling for free.
			const closeBtn = container?.querySelector(".modal-close, [data-dismiss]");
			if (!(closeBtn instanceof HTMLElement)) return false;
			closeBtn.click();
			return true;
		};
		if (escStack.length === 0) document.addEventListener("keydown", onStackEscape);
		escStack.push(onEsc);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			const idx = escStack.indexOf(onEsc);
			if (idx !== -1) escStack.splice(idx, 1);
			if (escStack.length === 0) document.removeEventListener("keydown", onStackEscape);
			previouslyFocused?.focus?.();
		};
	}, [active, initialFocusSelector]);
	return ref;
}

// A long list is one tab stop, not one per row: arrows move between its rows, and Tab leaves the list from the row
// that was focused last. Done on the DOM because the rows come from several loops with their own state; a row added
// later starts as a tab stop again until it is next focused past.
export function rovingRows(selector) {
	return {
		onFocusCapture: (e) => {
			if (!e.target.matches?.(selector)) return;
			for (const row of e.currentTarget.querySelectorAll(selector)) row.tabIndex = row === e.target ? 0 : -1;
		},
		onKeyDown: (e) => {
			if (!e.target.matches?.(selector)) return;
			const rows = [...e.currentTarget.querySelectorAll(selector)];
			const at = rows.indexOf(e.target);
			const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
			if (to === undefined || !rows[to]) return;
			e.preventDefault();
			rows[to].focus();
		},
	};
}

// Keyboard parity for a clickable row that can't be a <button> (it nests
// buttons of its own). Only the row's own keydown counts, so Enter inside a
// nested input or button keeps its own meaning.
export function pressable(onPress) {
	return {
		role: "button",
		tabIndex: 0,
		onClick: onPress,
		onKeyDown: (e) => {
			if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
			e.preventDefault();
			onPress(e);
		},
	};
}
