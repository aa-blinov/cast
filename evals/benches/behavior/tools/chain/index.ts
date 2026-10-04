import type { EvalCase } from "../../../../lib/runner.ts";
import { approvedPlanTodoProgress } from "./approved-plan-todo-progress.ts";
import { backgroundBashExplicitTimeout } from "./background-bash-explicit-timeout.ts";
import { backgroundBashKill } from "./background-bash-kill.ts";
import { backgroundBashOutput } from "./background-bash-output.ts";
import { backgroundDependentStep } from "./background-dependent-step.ts";
import { backgroundExplicitNotPolled } from "./background-explicit-not-polled.ts";
import { backgroundFailureReported } from "./background-failure-reported.ts";
import { backgroundKillNoNotice } from "./background-kill-no-notice.ts";
import { backgroundLargeOutput } from "./background-large-output.ts";
import { backgroundLongWaitPastCap } from "./background-long-wait-past-cap.ts";
import { backgroundParallelPromotedBothAwaited } from "./background-parallel-promoted-both-awaited.ts";
import { backgroundPromotedResultAwaited } from "./background-promoted-result-awaited.ts";
import { backgroundServerLifecycle } from "./background-server-lifecycle.ts";
import { backgroundTimeoutReported } from "./background-timeout-reported.ts";
import { backgroundWaitNoDuplicateNotice } from "./background-wait-no-duplicate-notice.ts";
import { bashFixRerunsCheck } from "./bash-fix-reruns-check.ts";
import { btwAnswersFromContext } from "./btw-answers-from-context.ts";
import { btwDoesNotReadFiles } from "./btw-does-not-read-files.ts";
import { btwDuringToolSeesRunningWork } from "./btw-during-tool-sees-running-work.ts";
import { btwSaysWhenUnknown } from "./btw-says-when-unknown.ts";
import { buildModeFlagsPlanDivergence } from "./build-mode-flags-plan-divergence.ts";
import { cleanContextPlanTodoState } from "./clean-context-plan-todo-state.ts";
import { commitStagesExplicitPaths } from "./commit-stages-explicit-paths.ts";
import { editAmbiguousNotWriteFallback } from "./edit-ambiguous-not-write-fallback.ts";
import { editTargetsOneDuplicateBlock } from "./edit-targets-one-duplicate-block.ts";
import { goalBlocksOnlyAfterRepeats } from "./goal-blocks-only-after-repeats.ts";
import { goalContinuesPastFirstStop } from "./goal-continues-past-first-stop.ts";
import { goalSurvivesCascadingFailures } from "./goal-survives-cascading-failures.ts";
import { independentReadsShareTurn } from "./independent-reads-share-turn.ts";
import { initWritesAgentsMdFromRepo } from "./init-writes-agents-md-from-repo.ts";
import { mcpLookupReportsNotFound } from "./mcp-lookup-reports-not-found.ts";
import { mcpReleaseLookupChain } from "./mcp-release-lookup-chain.ts";
import { mcpResourceAnswersFromIt } from "./mcp-resource-answers-from-it.ts";
import { mcpResourceMissingIsReported } from "./mcp-resource-missing-is-reported.ts";
import { mcpResourceTemplate } from "./mcp-resource-template.ts";
import { planDoneSignal } from "./plan-done-signal.ts";
import { planOpenQuestionBlocksDone } from "./plan-open-question-blocks-done.ts";
import { planReentryReusesExistingPlan } from "./plan-reentry-reuses-existing-plan.ts";
import { readBeforeEdit } from "./read-before-edit.ts";
import { readErrorThenRecover } from "./read-error-then-recover.ts";
import { ruleAlwaysApplyFollowed } from "./rule-always-apply-followed.ts";
import { ruleLazyNotReadWhenIrrelevant } from "./rule-lazy-not-read-when-irrelevant.ts";
import { ruleLazyReadWhenRelevant } from "./rule-lazy-read-when-relevant.ts";
import { searchThenRead } from "./search-then-read.ts";
import { skillArgumentsReachTheBody } from "./skill-arguments-reach-the-body.ts";
import { skillLoadsMatchingWorkflow } from "./skill-loads-matching-workflow.ts";
import { skillNotLoadedForGenericRequest } from "./skill-not-loaded-for-generic-request.ts";
import { skillReadsItsReferenceFile } from "./skill-reads-its-reference-file.ts";
import { taskDelegatesScopedInvestigation } from "./task-delegates-scoped-investigation.ts";
import { taskFollowUpWithTaskId } from "./task-follow-up-with-task-id.ts";
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
	taskFollowUpWithTaskId,
	taskParallelDelegation,
	todoWriteMarksStepDone,
	mcpLookupReportsNotFound,
	mcpResourceAnswersFromIt,
	mcpResourceTemplate,
	mcpResourceMissingIsReported,
	planReentryReusesExistingPlan,
	planOpenQuestionBlocksDone,
	buildModeFlagsPlanDivergence,
	taskWorkerDelegatesRealEdit,
	taskReviewFollowsNontrivialChange,
	skillNotLoadedForGenericRequest,
	approvedPlanTodoProgress,
	cleanContextPlanTodoState,
	skillReadsItsReferenceFile,
	skillArgumentsReachTheBody,
	ruleAlwaysApplyFollowed,
	ruleLazyReadWhenRelevant,
	ruleLazyNotReadWhenIrrelevant,
	btwAnswersFromContext,
	btwSaysWhenUnknown,
	backgroundWaitNoDuplicateNotice,
	backgroundExplicitNotPolled,
	backgroundParallelPromotedBothAwaited,
	backgroundFailureReported,
	backgroundDependentStep,
	backgroundServerLifecycle,
	backgroundTimeoutReported,
	backgroundLargeOutput,
	backgroundLongWaitPastCap,
	backgroundKillNoNotice,
	backgroundPromotedResultAwaited,
	btwDoesNotReadFiles,
	commitStagesExplicitPaths,
	initWritesAgentsMdFromRepo,
	btwDuringToolSeesRunningWork,
];
