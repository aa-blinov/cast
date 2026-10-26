import { describe, expect, it } from "vitest";
import {
	deleteSessionCostBudget,
	getSessionCostBudget,
	parseSessionCostCapArgument,
	SessionCostBudget,
	SessionCostLimitError,
} from "../src/core/cost-budget.ts";

describe("SessionCostBudget", () => {
	it("parses positive USD caps and the explicit off setting", () => {
		expect(parseSessionCostCapArgument("$1.25")).toEqual({ ok: true, capUsd: 1.25 });
		expect(parseSessionCostCapArgument("off")).toEqual({ ok: true, capUsd: undefined });
		expect(parseSessionCostCapArgument("0")).toEqual({ ok: false });
		expect(parseSessionCostCapArgument("Infinity")).toEqual({ ok: false });
	});

	it("stops the next request when reported cumulative spend reaches the cap", async () => {
		const budget = new SessionCostBudget({ capUsd: 0.25, reportedSpendUsd: 0, priceKnown: true });
		const first = await budget.beginRequest();
		first.settle(0.25);

		await expect(budget.beginRequest()).rejects.toBeInstanceOf(SessionCostLimitError);
		expect(budget.snapshot()).toEqual({ capUsd: 0.25, reportedSpendUsd: 0.25, priceKnown: true });
	});

	it("fails closed when a request has no provider-reported price", async () => {
		const budget = new SessionCostBudget({ capUsd: undefined, reportedSpendUsd: 0, priceKnown: true });
		const request = await budget.beginRequest();
		request.settle(undefined);
		budget.setCap(2);

		await expect(budget.beginRequest()).rejects.toMatchObject({ code: "cost_unknown" });
		expect(budget.snapshot().priceKnown).toBe(false);
	});

	it("releases the request queue when persisting an unknown price fails", async () => {
		const persistenceError = new Error("session store unavailable");
		const budget = new SessionCostBudget({ capUsd: 1, reportedSpendUsd: 0, priceKnown: true }, () => {
			throw persistenceError;
		});
		const request = await budget.beginRequest();

		expect(() => request.settle(undefined)).toThrow(persistenceError);
		const outcome = await Promise.race([
			budget.beginRequest().then(
				() => "started",
				(error: unknown) => (error instanceof Error && "code" in error ? error.code : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 25)),
		]);

		expect(outcome).toBe("cost_unknown");
	});

	it("serializes capped requests so parallel subagents cannot pass the same remaining budget", async () => {
		const budget = new SessionCostBudget({ capUsd: 1, reportedSpendUsd: 0, priceKnown: true });
		const first = await budget.beginRequest();
		let secondStarted = false;
		const secondPromise = budget.beginRequest().then((request) => {
			secondStarted = true;
			return request;
		});

		await Promise.resolve();
		expect(secondStarted).toBe(false);
		first.settle(0.4);
		const second = await secondPromise;
		expect(secondStarted).toBe(true);
		second.settle(0.6);
		await expect(budget.beginRequest()).rejects.toBeInstanceOf(SessionCostLimitError);
	});

	it("cancels a request while it waits for an earlier capped request", async () => {
		const budget = new SessionCostBudget({ capUsd: 1, reportedSpendUsd: 0, priceKnown: true });
		const first = await budget.beginRequest();
		const controller = new AbortController();
		const second = budget.beginRequest(controller.signal);
		controller.abort(new Error("cancelled while queued"));

		const outcome = await Promise.race([
			second.then(
				() => "started",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 25)),
		]);

		first.settle(0);
		expect(outcome).toBe("cancelled while queued");
		const third = await budget.beginRequest();
		third.settle(0);
	});

	it("releases a deleted session's live budget so the daemon does not retain it", () => {
		const first = getSessionCostBudget("deleted-session", { capUsd: 1, reportedSpendUsd: 0, priceKnown: true });
		deleteSessionCostBudget("deleted-session");
		const next = getSessionCostBudget("deleted-session", { capUsd: 2, reportedSpendUsd: 0, priceKnown: true });

		expect(next).not.toBe(first);
		expect(next.snapshot().capUsd).toBe(2);
		deleteSessionCostBudget("deleted-session");
	});
});
