import { watchProjectContextFiles } from "../../core/project-context-watcher.ts";

export interface ContextReloader {
	sync: (cwds: Iterable<string>) => void;
	notifyIdle: () => void;
	dispose: () => void;
}

export interface ContextReloaderDeps {
	isBusy: () => boolean;
	onChange: (cwd: string) => Promise<void>;
	extraPathsForCwd: (cwd: string) => string[];
}

/** Watches the contexts of live sessions and applies changes only between turns. */
export function createContextReloader(deps: ContextReloaderDeps): ContextReloader {
	const watchers = new Map<string, () => void>();
	const pending = new Set<string>();
	let reloading = false;

	function scheduleReload(): void {
		if (reloading || deps.isBusy() || pending.size === 0) return;
		const [cwd] = pending;
		if (!cwd) return;
		pending.delete(cwd);
		reloading = true;
		void deps
			.onChange(cwd)
			.catch((error: unknown) => {
				console.warn(`[context watcher] reload failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				reloading = false;
				scheduleReload();
			});
	}

	function sync(cwds: Iterable<string>): void {
		const active = new Set(cwds);
		for (const [cwd, stop] of watchers) {
			if (active.has(cwd)) continue;
			stop();
			watchers.delete(cwd);
			pending.delete(cwd);
		}
		for (const cwd of active) {
			if (watchers.has(cwd)) continue;
			watchers.set(
				cwd,
				watchProjectContextFiles(
					cwd,
					() => {
						pending.add(cwd);
						scheduleReload();
					},
					deps.extraPathsForCwd(cwd),
				),
			);
		}
	}

	function notifyIdle(): void {
		scheduleReload();
	}

	function dispose(): void {
		for (const stop of watchers.values()) stop();
		watchers.clear();
		pending.clear();
	}

	return { sync, notifyIdle, dispose };
}
