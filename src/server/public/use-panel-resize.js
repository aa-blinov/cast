import { useCallback, useRef } from "preact/hooks";

export function usePanelResize({ diffOpen, diffWidth, setDiffWidth, sidebarWidth, setSidebarWidth }) {
	const diffDragRef = useRef(null);
	const onDiffResizeMove = useCallback(
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
	const onDiffResizeEnd = useCallback(() => {
		diffDragRef.current = null;
		document.body.classList.remove("resizing-diff");
		window.removeEventListener("pointermove", onDiffResizeMove);
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
		},
		[diffWidth, onDiffResizeMove, onDiffResizeEnd],
	);

	const sidebarDragRef = useRef(null);
	const onSidebarResizeMove = useCallback(
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
	const onSidebarResizeEnd = useCallback(() => {
		sidebarDragRef.current = null;
		document.body.classList.remove("resizing-sidebar");
		window.removeEventListener("pointermove", onSidebarResizeMove);
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
		},
		[sidebarWidth, onSidebarResizeMove, onSidebarResizeEnd],
	);

	return { startDiffResize, startSidebarResize };
}
