import type { EvalCase } from "../../../../lib/runner.ts";
import { searchThenRead } from "./search-then-read.ts";
import { readBeforeEdit } from "./read-before-edit.ts";
import { independentReadsShareTurn } from "./independent-reads-share-turn.ts";
import { complexRequestEntersPlan } from "./complex-request-enters-plan.ts";
import { writeThenReadBack } from "./write-then-read-back.ts";
import { readErrorThenRecover } from "./read-error-then-recover.ts";
import { editTargetsOneDuplicateBlock } from "./edit-targets-one-duplicate-block.ts";
import { bashFixRerunsCheck } from "./bash-fix-reruns-check.ts";
import { taskDelegatesScopedInvestigation } from "./task-delegates-scoped-investigation.ts";
import { skillLoadsMatchingWorkflow } from "./skill-loads-matching-workflow.ts";
import { planDoneSignal } from "./plan-done-signal.ts";
import { planCheckUpdatesActivePlan } from "./plan-check-updates-active-plan.ts";
import { planDiscardRemovesDraft } from "./plan-discard-removes-draft.ts";
import { backgroundBashOutput } from "./background-bash-output.ts";
import { backgroundBashKill } from "./background-bash-kill.ts";
import { mcpReleaseLookupChain } from "./mcp-release-lookup-chain.ts";
import { editAmbiguousNotWriteFallback } from "./edit-ambiguous-not-write-fallback.ts";
import { backgroundBashExplicitTimeout } from "./background-bash-explicit-timeout.ts";
import { taskParallelDelegation } from "./task-parallel-delegation.ts";
import { todoWriteMarksStepDone } from "./todo-write-marks-step-done.ts";
import { mcpLookupReportsNotFound } from "./mcp-lookup-reports-not-found.ts";
import { planStepImplementsAndChecks } from "./plan-step-implements-and-checks.ts";

export const chainCases: EvalCase[] = [
	searchThenRead,
	readBeforeEdit,
	independentReadsShareTurn,
	complexRequestEntersPlan,
	writeThenReadBack,
	readErrorThenRecover,
	editTargetsOneDuplicateBlock,
	bashFixRerunsCheck,
	taskDelegatesScopedInvestigation,
	skillLoadsMatchingWorkflow,
	planDoneSignal,
	planCheckUpdatesActivePlan,
	planDiscardRemovesDraft,
	backgroundBashOutput,
	backgroundBashKill,
	mcpReleaseLookupChain,
	editAmbiguousNotWriteFallback,
	backgroundBashExplicitTimeout,
	taskParallelDelegation,
	todoWriteMarksStepDone,
	mcpLookupReportsNotFound,
	planStepImplementsAndChecks,
];
