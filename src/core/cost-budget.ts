export interface SessionCostSnapshot {
	capUsd?: number;
	reportedSpendUsd: number;
	priceKnown: boolean;
}

export type SessionCostLimitCode = "cost_cap_reached" | "cost_unknown";

export function parseSessionCostCapArgument(
	argument: string,
): { ok: true; capUsd: number | undefined } | { ok: false } {
	const value = argument.trim();
	if (value === "off") return { ok: true, capUsd: undefined };
	const amount = Number(value.startsWith("$") ? value.slice(1) : value);
	return Number.isFinite(amount) && amount > 0 ? { ok: true, capUsd: amount } : { ok: false };
}

export class SessionCostLimitError extends Error {
	readonly code: SessionCostLimitCode;

	constructor(code: SessionCostLimitCode, message: string) {
		super(message);
		this.name = "SessionCostLimitError";
		this.code = code;
	}
}

export interface SessionCostRequest {
	/** Call once after the provider attempt ends. Missing cost makes capped sessions fail closed. */
	settle(reportedCostUsd: number | undefined): void;
}

/** Tracks reported provider spend and gates new requests when a session cap is set. */
export class SessionCostBudget {
	private capUsd: number | undefined;
	private reportedSpendUsd: number;
	private priceKnown: boolean;
	private activeRequests = 0;
	private requestQueue: Promise<void> = Promise.resolve();
	private drainedWaiters: Array<() => void> = [];
	private readonly onPriceUnknown: (() => void) | undefined;

	constructor(snapshot: SessionCostSnapshot, onPriceUnknown?: () => void) {
		this.capUsd = snapshot.capUsd;
		this.reportedSpendUsd = Math.max(0, snapshot.reportedSpendUsd);
		this.priceKnown = snapshot.priceKnown;
		this.onPriceUnknown = onPriceUnknown;
	}

	snapshot(): SessionCostSnapshot {
		return {
			...(this.capUsd === undefined ? {} : { capUsd: this.capUsd }),
			reportedSpendUsd: this.reportedSpendUsd,
			priceKnown: this.priceKnown,
		};
	}

	setCap(capUsd: number | undefined): void {
		if (capUsd !== undefined && (!Number.isFinite(capUsd) || capUsd <= 0)) {
			throw new RangeError("Session cost cap must be a finite amount greater than zero.");
		}
		this.capUsd = capUsd;
	}

	markPriceUnknown(): void {
		if (this.priceKnown) {
			this.priceKnown = false;
			this.onPriceUnknown?.();
		}
	}

	async beginRequest(signal?: AbortSignal): Promise<SessionCostRequest> {
		if (signal?.aborted) throw signal.reason ?? new Error("Request aborted before it started.");
		if (this.capUsd === undefined) return this.beginUncappedRequest();

		let releaseQueue!: () => void;
		const previous = this.requestQueue;
		this.requestQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		await previous;
		try {
			await this.waitForActiveRequests(signal);
			if (signal?.aborted) throw signal.reason ?? new Error("Request aborted before it started.");
			this.assertAllowed();
			this.activeRequests++;
			return this.request(releaseQueue);
		} catch (error) {
			releaseQueue();
			throw error;
		}
	}

	private beginUncappedRequest(): SessionCostRequest {
		this.activeRequests++;
		return this.request(() => {});
	}

	private request(releaseQueue: () => void): SessionCostRequest {
		let settled = false;
		return {
			settle: (reportedCostUsd) => {
				if (settled) return;
				settled = true;
				if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
					this.reportedSpendUsd += reportedCostUsd;
				} else {
					this.markPriceUnknown();
				}
				this.activeRequests--;
				if (this.activeRequests === 0) {
					for (const resolve of this.drainedWaiters.splice(0)) resolve();
				}
				releaseQueue();
			},
		};
	}

	private async waitForActiveRequests(signal?: AbortSignal): Promise<void> {
		while (this.activeRequests > 0) {
			// A newly freed slot can be taken before this waiter resumes, so check again.
			// biome-ignore lint/performance/noAwaitInLoops: each active lease must drain before the next capped request starts
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					this.drainedWaiters = this.drainedWaiters.filter((waiter) => waiter !== onDrain);
					reject(signal?.reason ?? new Error("Request aborted while waiting for the session cost budget."));
				};
				const onDrain = () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				this.drainedWaiters.push(onDrain);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			if (signal?.aborted)
				throw signal.reason ?? new Error("Request aborted while waiting for the session cost budget.");
		}
	}

	private assertAllowed(): void {
		if (!this.priceKnown) {
			throw new SessionCostLimitError(
				"cost_unknown",
				"Session cost cap stopped the request because a previous provider response did not report its price. Start a new session or turn the cap off to continue.",
			);
		}
		if (this.capUsd !== undefined && this.reportedSpendUsd >= this.capUsd) {
			throw new SessionCostLimitError(
				"cost_cap_reached",
				`Session cost cap of $${this.capUsd.toFixed(4)} reached (provider-reported spend: $${this.reportedSpendUsd.toFixed(4)}).`,
			);
		}
	}
}

const sessionBudgets = new Map<string, SessionCostBudget>();

/** Share one budget across a session's turns and any background subagents. */
export function getSessionCostBudget(
	sessionId: string,
	snapshot: SessionCostSnapshot,
	onPriceUnknown?: () => void,
): SessionCostBudget {
	const existing = sessionBudgets.get(sessionId);
	if (existing) {
		existing.setCap(snapshot.capUsd);
		return existing;
	}
	const budget = new SessionCostBudget(snapshot, onPriceUnknown);
	sessionBudgets.set(sessionId, budget);
	return budget;
}

/** Drop the process-local budget when its session is removed. */
export function deleteSessionCostBudget(sessionId: string): void {
	sessionBudgets.delete(sessionId);
}

/** Apply a live command change only to a budget already used by an active session. */
export function setActiveSessionCostCap(sessionId: string, capUsd: number | undefined): void {
	sessionBudgets.get(sessionId)?.setCap(capUsd);
}
