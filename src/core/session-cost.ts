import { getSessionCostBudget, type SessionCostBudget } from "./cost-budget.ts";
import type { Usage } from "./llm.ts";
import { addUsage, loadSession, saveSession } from "./session.ts";

/** Reuse the live budget and its persisted session snapshot for any auxiliary request. */
export function getSessionCostBudgetForSession(sessionId: string): SessionCostBudget {
	const session = loadSession(sessionId);
	const usage = session?.usage;
	return getSessionCostBudget(
		sessionId,
		{
			capUsd: usage?.costCapUsd,
			reportedSpendUsd: usage?.reportedCostUsd ?? 0,
			priceKnown: usage?.costPriceKnown ?? usage?.totalTokens === 0,
		},
		() => {
			const latest = loadSession(sessionId);
			if (!latest || latest.usage.costPriceKnown === false) return;
			latest.usage.costPriceKnown = false;
			saveSession(latest);
		},
	);
}

/** Persist usage for auxiliary requests that do not report through the active loop. */
export function recordSessionCostUsage(sessionId: string, usage: Usage): void {
	const session = loadSession(sessionId);
	if (!session) return;
	addUsage(session, usage);
	saveSession(session);
}
