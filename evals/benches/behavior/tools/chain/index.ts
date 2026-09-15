import type { EvalCase } from "../../../../lib/runner.ts";
import { approvedPlanTodoProgress } from "./approved-plan-todo-progress.ts";
import { backgroundBashExplicitTimeout } from "./background-bash-explicit-timeout.ts";
import { backgroundBashKill } from "./background-bash-kill.ts";
import { backgroundBashOutput } from "./background-bash-output.ts";
import { bashFixRerunsCheck } from "./bash-fix-reruns-check.ts";
import { buildModeFlagsPlanDivergence } from "./build-mode-flags-plan-divergence.ts";
import { cleanContextPlanTodoState } from "./clean-context-plan-todo-state.ts";
import { editAmbiguousNotWriteFallback } from "./edit-ambiguous-not-write-fallback.ts";
import { editTargetsOneDuplicateBlock } from "./edit-targets-one-duplicate-block.ts";
import { goalBlocksOnlyAfterRepeats } from "./goal-blocks-only-after-repeats.ts";
import { goalContinuesPastFirstStop } from "./goal-continues-past-first-stop.ts";
import { goalSurvivesCascadingFailures } from "./goal-survives-cascading-failures.ts";
import { independentReadsShareTurn } from "./independent-reads-share-turn.ts";
import { mcpLookupReportsNotFound } from "./mcp-lookup-reports-not-found.ts";
import { mcpReleaseLookupChain } from "./mcp-release-lookup-chain.ts";
import { planDoneSignal } from "./plan-done-signal.ts";
import { planOpenQuestionBlocksDone } from "./plan-open-question-blocks-done.ts";
import { planReentryReusesExistingPlan } from "./plan-reentry-reuses-existing-plan.ts";
import { readBeforeEdit } from "./read-before-edit.ts";
import { readErrorThenRecover } from "./read-error-then-recover.ts";
import { searchThenRead } from "./search-then-read.ts";
import { skillLoadsMatchingWorkflow } from "./skill-loads-matching-workflow.ts";
import { skillNotLoadedForGenericRequest } from "./skill-not-loaded-for-generic-request.ts";
import { taskDelegatesScopedInvestigation } from "./task-delegates-scoped-investigation.ts";
import { taskParallelDelegation } from "./task-parallel-delegation.ts";
import { taskReviewFollowsNontrivialChange } from "./task-review-follows-nontrivial-change.ts";
import { taskWorkerDelegatesRealEdit } from "./task-worker-delegates-real-edit.ts";
import { todoWriteMarksStepDone } from "./todo-write-marks-step-done.ts";
import { writeThenReadBack } from "./write-then-read-back.ts";

export const chainCases: EvalCase[] = [
	goalContinuesPastFirstStop,
	goalSurvivesCascadingFailures,
	goalBlocksOnlyAfterRepeats,
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
