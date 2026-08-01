import type { EvalCase } from "../../../../lib/runner.ts";
import { searchThenRead } from "./search-then-read.ts";
import { readBeforeEdit } from "./read-before-edit.ts";
import { independentReadsShareTurn } from "./independent-reads-share-turn.ts";
import { writeThenReadBack } from "./write-then-read-back.ts";
import { readErrorThenRecover } from "./read-error-then-recover.ts";
import { editTargetsOneDuplicateBlock } from "./edit-targets-one-duplicate-block.ts";
import { bashFixRerunsCheck } from "./bash-fix-reruns-check.ts";
import { taskDelegatesScopedInvestigation } from "./task-delegates-scoped-investigation.ts";
import { skillLoadsMatchingWorkflow } from "./skill-loads-matching-workflow.ts";
import { planDoneSignal } from "./plan-done-signal.ts";
import { backgroundBashOutput } from "./background-bash-output.ts";
import { backgroundBashKill } from "./background-bash-kill.ts";
import { mcpReleaseLookupChain } from "./mcp-release-lookup-chain.ts";
import { editAmbiguousNotWriteFallback } from "./edit-ambiguous-not-write-fallback.ts";
import { backgroundBashExplicitTimeout } from "./background-bash-explicit-timeout.ts";
import { taskParallelDelegation } from "./task-parallel-delegation.ts";
import { todoWriteMarksStepDone } from "./todo-write-marks-step-done.ts";
import { mcpLookupReportsNotFound } from "./mcp-lookup-reports-not-found.ts";
import { planReentryReusesExistingPlan } from "./plan-reentry-reuses-existing-plan.ts";
import { planOpenQuestionBlocksDone } from "./plan-open-question-blocks-done.ts";
import { buildModeFlagsPlanDivergence } from "./build-mode-flags-plan-divergence.ts";
import { taskWorkerDelegatesRealEdit } from "./task-worker-delegates-real-edit.ts";
import { taskReviewFollowsNontrivialChange } from "./task-review-follows-nontrivial-change.ts";
import { skillNotLoadedForGenericRequest } from "./skill-not-loaded-for-generic-request.ts";
import { approvedPlanTodoProgress } from "./approved-plan-todo-progress.ts";
import { cleanContextPlanTodoState } from "./clean-context-plan-todo-state.ts";

export const chainCases: EvalCase[] = [
	searchThenRead,
	readBeforeEdit,
	independentReadsShareTurn,
	writeThenReadBack,
	readErrorThenRecover,
	editTargetsOneDuplicateBlock,
	bashFixRerunsCheck,
	taskDelegatesScopedInvestigation,
	skillLoadsMatchingWorkflow,
	planDoneSignal,
	backgroundBashOutput,
	backgroundBashKill,
	mcpReleaseLookupChain,
	editAmbiguousNotWriteFallback,
	backgroundBashExplicitTimeout,
	taskParallelDelegation,
	todoWriteMarksStepDone,
	mcpLookupReportsNotFound,
	planReentryReusesExistingPlan,
	planOpenQuestionBlocksDone,
	buildModeFlagsPlanDivergence,
	taskWorkerDelegatesRealEdit,
	taskReviewFollowsNontrivialChange,
	skillNotLoadedForGenericRequest,
	approvedPlanTodoProgress,
	cleanContextPlanTodoState,
];
