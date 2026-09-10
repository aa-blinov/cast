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

/**
 * Whether the list should keep following new content after a scroll event.
 * Near the bottom it always follows. Away from it, only a scroll *up*
 * (scrollTop below the previous reading) turns following off: content
 * growing under a pinned view fires no scroll event, and the follow-up
 * programmatic scroll only ever moves down. Measuring "near bottom" alone was
 * wrong once a streaming frame grew the list by more than the threshold: the
 * scroll handler read the position after the render but before the catch-up
 * scroll, saw it far from the bottom and stopped following for good.
 *
 * A scroll event that comes with a *shorter* list is the browser clamping
 * scrollTop to the new height, not the user: when the streaming block is
 * swapped for the settled message, that message is laid out as its
 * content-visibility placeholder for one frame, the list collapses to a few
 * hundred px, scrollTop snaps to 0 — which reads as "at the bottom" and
 * dragged a reader who had scrolled up back down once the message got its
 * real height. The state is left alone for those.
 */
export function shouldFollow(wasFollowing, scrollTop, previousScrollTop, clientHeight, scrollHeight, previousScrollHeight = 0) {
	if (scrollHeight < previousScrollHeight) return wasFollowing;
	if (isNearBottom(scrollTop, clientHeight, scrollHeight)) return true;
	if (scrollTop < previousScrollTop) return false;
	return wasFollowing;
}
