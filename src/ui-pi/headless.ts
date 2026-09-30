import type { ReactElement } from "react";
import createReconciler from "react-reconciler";
import { DefaultEventPriority, NoEventPriority } from "react-reconciler/constants.js";

// A React renderer with nothing to draw. The app's state lives in hooks
// (useAppModel); a front end that is not React-shaped still needs them to run,
// so they run here, in components that return null, and the front end reads
// what they produce from a store.

type Nothing = Record<string, never>;

let currentPriority: number = NoEventPriority;

type Continuation = (didTimeout: boolean) => unknown;

/** The scheduler's contract: run later, and run whatever continuation the callback returns. */
function schedule(callback: Continuation): { cancelled: boolean } {
	const handle = { cancelled: false };
	const run = (work: Continuation) => {
		setImmediate(() => {
			if (handle.cancelled) return;
			const next = work(false);
			if (typeof next === "function") run(next as Continuation);
		});
	};
	run(callback);
	return handle;
}

// The reconciler reads these from its host config; its type declarations lag the
// library and leave them out, so they ride in by spread, which TypeScript does not
// check property by property.
const scheduling = {
	scheduleCallback: (_priority: number, callback: Continuation) => schedule(callback),
	cancelCallback: (handle: unknown) => {
		(handle as { cancelled: boolean }).cancelled = true;
	},
	shouldYield: () => false,
	now: () => performance.now(),
};

const reconciler = createReconciler<
	string,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	Nothing,
	unknown,
	NodeJS.Timeout,
	-1,
	null,
	null,
	Nothing,
	Nothing,
	Nothing,
	Nothing
>({
	...scheduling,
	rendererPackageName: "cast-headless",
	rendererVersion: "1",
	extraDevToolsConfig: null,
	bindToConsole: () => () => undefined,
	supportsMutation: true,
	supportsPersistence: false,
	supportsHydration: false,
	isPrimaryRenderer: true,
	supportsMicrotasks: true,
	scheduleMicrotask: queueMicrotask,
	scheduleTimeout: setTimeout,
	cancelTimeout: clearTimeout,
	noTimeout: -1,
	getRootHostContext: () => ({}),
	getChildHostContext: (parent) => parent,
	prepareForCommit: () => null,
	resetAfterCommit: () => {},
	preparePortalMount: () => {},
	clearContainer: () => false,
	shouldSetTextContent: () => false,
	createInstance: () => ({}),
	createTextInstance: () => ({}),
	appendInitialChild: () => {},
	appendChild: () => {},
	appendChildToContainer: () => {},
	insertBefore: () => {},
	insertInContainerBefore: () => {},
	removeChild: () => {},
	removeChildFromContainer: () => {},
	finalizeInitialChildren: () => false,
	commitUpdate: () => {},
	commitTextUpdate: () => {},
	resetTextContent: () => {},
	hideInstance: () => {},
	hideTextInstance: () => {},
	unhideInstance: () => {},
	unhideTextInstance: () => {},
	getPublicInstance: (instance) => instance,
	detachDeletedInstance: () => {},
	beforeActiveInstanceBlur: () => {},
	afterActiveInstanceBlur: () => {},
	prepareScopeUpdate: () => {},
	getInstanceFromNode: () => null,
	getInstanceFromScope: () => null,
	setCurrentUpdatePriority: (priority) => {
		currentPriority = priority;
	},
	getCurrentUpdatePriority: () => currentPriority,
	resolveUpdatePriority: () => (currentPriority !== NoEventPriority ? currentPriority : DefaultEventPriority),
	maySuspendCommit: () => false,
	maySuspendCommitOnUpdate: () => false,
	maySuspendCommitInSyncRender: () => false,
	suspendOnActiveViewTransition: () => {},
	getSuspendedCommitReason: () => null,
	NotPendingTransition: null,
	HostTransitionContext: { $$typeof: Symbol.for("react.context"), _currentValue: null } as never,
	resetFormInstance: () => {},
	requestPostPaintCallback: () => {},
	shouldAttemptEagerTransition: () => false,
	trackSchedulerEvent: () => {},
	resolveEventType: () => null,
	resolveEventTimeStamp: () => -1.1,
	preloadInstance: () => true,
	startSuspendingCommit: () => null,
	suspendInstance: () => {},
	waitForCommitToBeReady: () => null,
});

/** Renders `element` into nothing and keeps it alive until `unmount`. */
export function mountHeadless(element: ReactElement, onError: (error: Error) => void): { unmount: () => void } {
	const container = reconciler.createContainer(
		{},
		0,
		null,
		false,
		null,
		"headless",
		onError,
		onError,
		onError,
		() => {},
		null,
	);
	reconciler.updateContainerSync(element, container, null, () => {});
	reconciler.flushSyncWork();
	return {
		unmount: () => {
			reconciler.updateContainerSync(null, container, null, () => {});
			reconciler.flushSyncWork();
		},
	};
}

/** A value a hook produces on every render, for something that is not React to read. */
export function createStore<T>(): {
	get: () => T | undefined;
	set: (value: T) => void;
	subscribe: (listener: (value: T) => void) => () => void;
} {
	let current: T | undefined;
	const listeners = new Set<(value: T) => void>();
	return {
		get: () => current,
		set: (value) => {
			current = value;
			for (const listener of listeners) listener(value);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
