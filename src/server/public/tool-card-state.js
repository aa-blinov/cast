// Per-tool-card UI state (open / previewSrc) that survives the
// streaming-tree → settled-message-tree swap. The streaming controller
// unmounts the live ToolCard when `assistant_message` fires
// (takeStreamingNow) and the same blocks re-mount inside a `Message`
// (settled) — two separate component instances, useState doesn't carry
// between them. Keying by tool-call id in a shared Map does.
//
// Each entry is tiny (a bool + a string ref), and the map only grows for
// call ids the user actually opens/previews — closed cards never write
// here. Worst case grows with session lifetime; not a concern for any
// realistic session size.

const states = new Map();

function getState(id) {
	let s = states.get(id);
	if (!s) {
		s = { open: false, previewSrc: null };
		states.set(id, s);
	}
	return s;
}

export function getToolCardOpen(id) {
	return getState(id).open;
}

export function setToolCardOpen(id, value) {
	const s = getState(id);
	s.open = typeof value === "function" ? value(s.open) : value;
}

export function getToolCardPreviewSrc(id) {
	return getState(id).previewSrc;
}

export function setToolCardPreviewSrc(id, value) {
	const s = getState(id);
	s.previewSrc = typeof value === "function" ? value(s.previewSrc) : value;
}

// Live `subagent_progress` of task cards, by tool-call id. A background task
// keeps reporting after its card has settled into the transcript, so this
// lives outside both the streaming and the settled trees, like the state
// above; cards subscribe to hear about their own id.
const progressById = new Map();
const progressListeners = new Set();

export function setSubagentProgress(progress) {
	progressById.set(progress.toolCallId, progress);
	for (const listener of progressListeners) listener(progress.toolCallId);
}

export function getSubagentProgress(id) {
	return progressById.get(id);
}

export function subscribeSubagentProgress(listener) {
	progressListeners.add(listener);
	return () => progressListeners.delete(listener);
}
