import { useEffect, useRef } from "preact/hooks";

export const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Shared by every modal: move focus into the dialog, keep Tab inside it, and
// restore the triggering element when the dialog closes.
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
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			previouslyFocused?.focus?.();
		};
	}, [active, initialFocusSelector]);
	return ref;
}
