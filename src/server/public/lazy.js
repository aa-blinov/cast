import { h } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * Code-splitting for features that live behind a click.
 *
 * The app loaded every module before the first paint — the settings modal and
 * its fifteen panels, the dashboard, the new-session modal, the workspace
 * panel and its three explorers — about 150KB of JavaScript for screens most
 * visits never open, on a daemon that is routinely reached over a network
 * where each of those requests costs a round trip.
 *
 * `lazy` returns a component that renders nothing until its module arrives.
 * That would trade bytes for a visible delay on the first click, so the
 * modules are also prefetched once the page has gone idle (`prefetchWhenIdle`)
 * — by the time anything is clicked they are in the browser's cache, and the
 * first paint no longer waits for them.
 */
export function lazy(loader, pick) {
	let promise = null;
	let Loaded = null;
	const load = () => {
		if (!promise) {
			promise = loader().then((module) => {
				// A module with one export needs no name at the call site.
				Loaded = pick ? pick(module) : (module.default ?? Object.values(module)[0]);
				return Loaded;
			});
		}
		return promise;
	};
	function Lazy(props) {
		const [, bump] = useState(0);
		useEffect(() => {
			if (Loaded) return;
			let live = true;
			load().then(() => {
				if (live) bump((n) => n + 1);
			});
			return () => {
				live = false;
			};
		}, []);
		return Loaded ? h(Loaded, props) : null;
	}
	Lazy.preload = load;
	return Lazy;
}

/**
 * Warm the split modules after the page settles. requestIdleCallback so this
 * never competes with the first render or with a turn that is already
 * streaming; a timeout fallback for Safari, which still lacks it.
 */
export function prefetchWhenIdle(components, delayMs = 1500) {
	const run = () => {
		for (const component of components) component.preload?.();
	};
	if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 4000 });
	else setTimeout(run, delayMs);
}
