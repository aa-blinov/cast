import { useCallback, useEffect, useMemo, useRef } from "preact/hooks";

// Pointer events arrive faster than the grid can relayout the transcript, so
// apply at most one width per frame. flush() lands the last position on
// release instead of dropping it with the pending frame.
export function perFrame(apply) {
	let id = 0;
	let last = null;
	const run = (event) => {
		last = event;
		if (!id) {
			id = requestAnimationFrame(() => {
				id = 0;
				apply(last);
			});
		}
	};
	run.flush = () => {
		if (!id) return;
		cancelAnimationFrame(id);
		id = 0;
		apply(last);
	};
	return run;
}

// Width limits shared by drag and keyboard, read at event time because they
// depend on what the other panel occupies right now.
function diffWidthRange() {
	const sidebarWidthNow = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
	const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
	return {
		min: 320,
		max: Math.max(320, Math.min(Math.round(window.innerWidth * 0.85), window.innerWidth - sidebarWidthNow - minChatWidth)),
	};
}

function sidebarWidthRange(diffOpen) {
	const diffWidthNow = diffOpen ? (document.querySelector(".diff-panel")?.getBoundingClientRect().width ?? 0) : 0;
	const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
	return {
		min: 272,
		max: Math.max(272, Math.min(420, Math.round(window.innerWidth * 0.45), window.innerWidth - diffWidthNow - minChatWidth)),
	};
}

// Keyboard parity for the drag: arrows move the divider the way a drag would
// (growKey is the direction that widens this panel), Shift for bigger steps,
// Home/End to the limits. null means the key isn't ours.
export function nextWidthForKey(key, shiftKey, current, { min, max }, growKey) {
	const step = shiftKey ? 64 : 16;
	if (key === "Home") return min;
	if (key === "End") return max;
	if (key === growKey) return Math.min(current + step, max);
	if (key === "ArrowLeft" || key === "ArrowRight") return Math.max(current - step, min);
	return null;
}

export function usePanelResize({ diffOpen, diffWidth, setDiffWidth, sidebarWidth, setSidebarWidth }) {
	const diffDragRef = useRef(null);
	const applyDiffResize = useCallback(
		(event) => {
			const state = diffDragRef.current;
			if (!state) return;
			const { min, max } = diffWidthRange();
			setDiffWidth(Math.min(Math.max(state.startWidth + state.startX - event.clientX, min), max));
		},
		[setDiffWidth],
	);
	const onDiffResizeMove = useMemo(() => perFrame(applyDiffResize), [applyDiffResize]);
	const onDiffResizeEnd = useCallback(() => {
		onDiffResizeMove.flush();
		diffDragRef.current = null;
		document.body.classList.remove("resizing-diff");
		window.removeEventListener("pointermove", onDiffResizeMove);
		window.removeEventListener("pointerup", onDiffResizeEnd);
		window.removeEventListener("pointercancel", onDiffResizeEnd);
		window.removeEventListener("blur", onDiffResizeEnd);
	}, [onDiffResizeMove]);
	const startDiffResize = useCallback(
		(event) => {
			event.preventDefault();
			const panel = document.querySelector(".diff-panel");
			diffDragRef.current = {
				startX: event.clientX,
				startWidth: panel?.getBoundingClientRect().width ?? diffWidth ?? 560,
			};
			document.body.classList.add("resizing-diff");
			window.addEventListener("pointermove", onDiffResizeMove);
			window.addEventListener("pointerup", onDiffResizeEnd, { once: true });
			window.addEventListener("pointercancel", onDiffResizeEnd, { once: true });
			// A release the window never sees (alt-tab, capture stolen) would
			// otherwise leave the drag stuck to the pointer.
			window.addEventListener("blur", onDiffResizeEnd, { once: true });
			if (event.target?.setPointerCapture) {
				try {
					event.target.setPointerCapture(event.pointerId);
					event.target.addEventListener("lostpointercapture", onDiffResizeEnd, { once: true });
				} catch {}
			}
		},
		[diffWidth, onDiffResizeMove, onDiffResizeEnd],
	);

	const sidebarDragRef = useRef(null);
	const applySidebarResize = useCallback(
		(event) => {
			const state = sidebarDragRef.current;
			if (!state) return;
			const { min, max } = sidebarWidthRange(diffOpen);
			setSidebarWidth(Math.min(Math.max(state.startWidth + event.clientX - state.startX, min), max));
		},
		[diffOpen, setSidebarWidth],
	);
	const onSidebarResizeMove = useMemo(() => perFrame(applySidebarResize), [applySidebarResize]);
	const onSidebarResizeEnd = useCallback(() => {
		onSidebarResizeMove.flush();
		sidebarDragRef.current = null;
		document.body.classList.remove("resizing-sidebar");
		window.removeEventListener("pointermove", onSidebarResizeMove);
		window.removeEventListener("pointerup", onSidebarResizeEnd);
		window.removeEventListener("pointercancel", onSidebarResizeEnd);
		window.removeEventListener("blur", onSidebarResizeEnd);
	}, [onSidebarResizeMove]);
	const startSidebarResize = useCallback(
		(event) => {
			if (window.innerWidth <= 768) return;
			event.preventDefault();
			const sidebar = document.querySelector(".sidebar");
			sidebarDragRef.current = {
				startX: event.clientX,
				startWidth: sidebar?.getBoundingClientRect().width ?? sidebarWidth ?? 272,
			};
			document.body.classList.add("resizing-sidebar");
			window.addEventListener("pointermove", onSidebarResizeMove);
			window.addEventListener("pointerup", onSidebarResizeEnd, { once: true });
			window.addEventListener("pointercancel", onSidebarResizeEnd, { once: true });
			// A release the window never sees (alt-tab, capture stolen) would
			// otherwise leave the drag stuck to the pointer.
			window.addEventListener("blur", onSidebarResizeEnd, { once: true });
			if (event.target?.setPointerCapture) {
				try {
					event.target.setPointerCapture(event.pointerId);
					event.target.addEventListener("lostpointercapture", onSidebarResizeEnd, { once: true });
				} catch {}
			}
		},
		[sidebarWidth, onSidebarResizeMove, onSidebarResizeEnd],
	);

	// Ensure no dangling listeners survive unmount mid-drag.
	useEffect(
		() => () => {
			window.removeEventListener("pointermove", onDiffResizeMove);
			window.removeEventListener("pointermove", onSidebarResizeMove);
			document.body.classList.remove("resizing-diff", "resizing-sidebar");
		},
		[onDiffResizeMove, onSidebarResizeMove],
	);

	const diffResizeKey = useCallback(
		(event) => {
			// State first: the grid animates each step, so a quick second press
			// would measure a width still on its way to the last one.
			const current = diffWidth ?? document.querySelector(".diff-panel")?.getBoundingClientRect().width ?? 560;
			// The diff handle is on the panel's left edge: moving it left widens.
			const next = nextWidthForKey(event.key, event.shiftKey, current, diffWidthRange(), "ArrowLeft");
			if (next === null) return;
			event.preventDefault();
			setDiffWidth(Math.round(next));
		},
		[diffWidth, setDiffWidth],
	);
	const sidebarResizeKey = useCallback(
		(event) => {
			const current = sidebarWidth ?? document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 272;
			const next = nextWidthForKey(event.key, event.shiftKey, current, sidebarWidthRange(diffOpen), "ArrowRight");
			if (next === null) return;
			event.preventDefault();
			setSidebarWidth(Math.round(next));
		},
		[diffOpen, sidebarWidth, setSidebarWidth],
	);

	// Everything a handle needs to be a focusable window splitter. valuemax is
	// the viewport bound (no layout read during render); the exact limit, which
	// also depends on the other panel, is applied when the width changes.
	const diffHandleProps = {
		role: "separator",
		tabIndex: 0,
		"aria-orientation": "vertical",
		"aria-label": "Resize workspace panel",
		"aria-valuemin": 320,
		"aria-valuemax": Math.round(window.innerWidth * 0.85),
		"aria-valuenow": diffWidth ?? undefined,
		onPointerDown: startDiffResize,
		onKeyDown: diffResizeKey,
	};
	const sidebarHandleProps = {
		role: "separator",
		tabIndex: 0,
		"aria-orientation": "vertical",
		"aria-label": "Resize sessions panel",
		"aria-valuemin": 272,
		"aria-valuemax": Math.min(420, Math.round(window.innerWidth * 0.45)),
		"aria-valuenow": sidebarWidth ?? undefined,
		onPointerDown: startSidebarResize,
		onKeyDown: sidebarResizeKey,
	};

	return { diffHandleProps, sidebarHandleProps };
}
