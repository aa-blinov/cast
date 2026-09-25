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

export function usePanelResize({ diffOpen, diffWidth, setDiffWidth, sidebarWidth, setSidebarWidth }) {
	const diffDragRef = useRef(null);
	const applyDiffResize = useCallback(
		(event) => {
			const state = diffDragRef.current;
			if (!state) return;
			const delta = state.startX - event.clientX;
			const sidebarWidthNow = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
			const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
			const maxWidth = Math.max(
				320,
				Math.min(Math.round(window.innerWidth * 0.85), window.innerWidth - sidebarWidthNow - minChatWidth),
			);
			setDiffWidth(Math.min(Math.max(state.startWidth + delta, 320), maxWidth));
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
			const diffWidthNow = diffOpen
				? (document.querySelector(".diff-panel")?.getBoundingClientRect().width ?? 0)
				: 0;
			const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
			const maxWidth = Math.max(
				272,
				Math.min(420, Math.round(window.innerWidth * 0.45), window.innerWidth - diffWidthNow - minChatWidth),
			);
			setSidebarWidth(Math.min(Math.max(state.startWidth + event.clientX - state.startX, 272), maxWidth));
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

	return { startDiffResize, startSidebarResize };
}
