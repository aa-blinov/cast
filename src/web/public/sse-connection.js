/**
 * Open an EventSource with a single, explicit lifecycle owner.
 * Keeping the transport setup here prevents individual UI effects from
 * forgetting to close a stream or from assigning handlers after cleanup.
 */
export function openSseConnection(url, { onOpen, onMessage, onError } = {}) {
	const source = new EventSource(url);
	if (onOpen) source.onopen = onOpen;
	if (onMessage) source.onmessage = onMessage;
	if (onError) source.onerror = onError;
	return source;
}

export function closeSseConnection(source) {
	if (source) source.close();
}
