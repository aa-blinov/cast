// Pure scroll-position math for the message list in app.js — split out so it
// can be unit tested without mocking preact/htm (app.js's onScroll handler
// and the "restore position after prepending older messages" effect are
// otherwise pure DOM-event wiring around exactly this arithmetic).

/** True once the list is scrolled close enough to the bottom that new content should keep auto-scrolling it. */
export function isNearBottom(scrollTop, clientHeight, scrollHeight, threshold = 80) {
	return scrollTop + clientHeight >= scrollHeight - threshold;
}

/** True once the list is scrolled close enough to the top to prefetch older history. */
export function isNearTop(scrollTop, threshold = 600) {
	return scrollTop < threshold;
}

/**
 * Where scrollTop must land after older messages get prepended above the
 * current view, so the content the user was looking at stays put instead of
 * jumping by the height of what was just inserted (the browser's default
 * "preserve scrollTop" behavior otherwise reads as the thread scrolling on
 * its own). `previousScrollHeight` is a snapshot taken right before the
 * prepend; `newScrollHeight` is the list's height right after.
 */
export function scrollTopAfterPrepend(currentScrollTop, newScrollHeight, previousScrollHeight) {
	return currentScrollTop + (newScrollHeight - previousScrollHeight);
}
