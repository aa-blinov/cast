import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatContextFilesForPrompt, resolveNestedContextFiles } from "../core/context-files.ts";
import { lspStatus } from "../core/lsp/index.ts";
import { closeMcpConnections, formatMcpForPrompt } from "../core/mcp.ts";
import type { AskMcpForm } from "../core/mcp-interaction.ts";
import { findPersona, listPersonas, type Persona } from "../core/personas.ts";
import {
	createPlanState,
	createPlanTodos,
	modeDisabledTools,
	readActivePlan,
	readPlanQuestion,
	readPlanTransition,
	resolvePlanQuestion,
	resolvePlanTransition,
} from "../core/plan.ts";
import {
	buildSystemPrompt,
	makeConfirmBash,
	personaOptionsForCwd,
	resolveMcpForCwd,
	resolveSkillsForCwd,
	rulesCwd,
} from "../core/project.ts";
import {
	formatRulesForTurn,
	latchedRuleIds,
	matchAutoRules,
	type Rule,
	restoreLatchedRules,
	selectMentionedRules,
	unionStickyRules,
} from "../core/rules.ts";
import { resetSessionContext, saveSession } from "../core/session.ts";
import { type HeaderConfig, loadSettings, type StatusBarConfig } from "../core/settings.ts";
import { formatSkillsForPrompt } from "../core/skills.ts";
import type { StartupResult } from "../core/startup.ts";
import { fetchLatestVersion, isNewerVersion, isReleaseInstall } from "../core/upgrade.ts";
import { canSubmitDuringRun, handleInput } from "./commands.ts";
import { displayWidth } from "./display-width.ts";
import { defaultHeaderConfig } from "./header.ts";
import { runMcpForm } from "./mcp-form.ts";
import { imageFilePathsInText } from "./paste.ts";
import { useModalBridge } from "./pickerBridge.ts";
import { resolvePlanQuestionWithPicker } from "./plan-question.ts";
import { defaultStatusBarConfig } from "./statusbar.ts";
import { notifyTerminal } from "./terminal-notify.ts";
import { type ChatMessage, type PendingImage, useAgentSession } from "./useAgentSession.ts";

// Attach the pasted image inline, not as a bare path the model must `read`.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
// Providers reject absurdly large inline images; anything bigger is left as a
// path the read tool can still handle.
const MAX_ATTACHED_IMAGE_BYTES = 20 * 1024 * 1024;

async function readImageFilesFromText(text: string): Promise<PendingImage[]> {
	const images: PendingImage[] = [];
	for (const path of imageFilePathsInText(text)) {
		try {
			const data = readFileSync(path);
			if (data.byteLength > MAX_ATTACHED_IMAGE_BYTES) continue;
			const ext = path.split(".").pop()!.toLowerCase();
			images.push({
				id: randomUUID(),
				dataUrl: `data:${IMAGE_MIME_BY_EXT[ext] ?? "image/png"};base64,${data.toString("base64")}`,
			});
		} catch {
			// Not a readable image file — leave the path as plain text.
		}
	}
	return images;
}

/** Rows a notice would occupy on the current terminal — the live notice line
 *  wraps, so a single long line counts for as many rows as it takes. */
function noticeRows(text: string): number {
	const cols = Math.max(20, process.stdout.columns || 80);
	return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / cols)), 0);
}

/** Above this a notice is transcript content, not a toast. */
const MAX_NOTICE_ROWS = 3;

export /**
 * `ctx <used>/<budget> (<pct>%)`.
 *
 * The denominator is the *input budget* — the window minus the reply reserve —
 * because that is what the percentage is computed against and what compaction
 * measures against. It used to print the raw context window next to a
 * percentage derived from the budget, so the two halves of the same string
 * disagreed: a 128k model with the default 32k reserve rendered
 * `ctx 94.7k/128k (99%)`, where 94.7/128 is 74%, and a 32k model rendered
 * `ctx 94.7k/32.8k (578%)`.
 */
/**
 * The prompts the user actually typed in this session, oldest first — what ↑
 * recalls in the composer.
 *
 * Read off the rendered transcript rather than the wire messages: the display
 * list already has cast's own `<system-reminder>` traffic split out into
 * `warning` rows (background-task notices, the post-compaction state block,
 * attached-file lists), so a user row here is exactly what someone typed.
 */
function submittedPrompts(messages: readonly ChatMessage[]): string[] {
	const prompts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string" && message.content.trim()) prompts.push(message.content);
	}
	return prompts;
}

export interface AppModelProps {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	onQuit: () => void;
	/** A theme switch: the view repaints everything in the new colours. */
	onThemeChange: () => void;
	/** History changed under what is drawn (a fork, /older): the view redraws it. */
	onRepaintHistory: () => void;
	/** When set, runs as a thin client of the `cast server` daemon. */
	daemonUrl?: string;
	daemonToken?: string;
}

/**
 * Everything the screen shows and every command acts on, with no drawing in it:
 * the agent session, the modal bridge, plan-mode decisions, the status-bar
 * config. A front end calls this and draws what it returns, so
 * the two never diverge on behaviour.
 */
export function useAppModel(props: AppModelProps) {
	const { result, version, initialPrompt, onQuit, onThemeChange, onRepaintHistory, daemonUrl, daemonToken } = props;
	const { config, runner, backgroundTasks } = result;

	const [notice, setNotice] = useState<string | null>(null);
	const noticeDurationRef = useRef(6000);
	// Set once the agent session exists — showNotice is created before it
	// (useModalBridge below needs it) but only ever called after mount.
	const addDisplayMessageRef = useRef<((message: ChatMessage) => void) | null>(null);
	const showNotice = useCallback((text: string, duration?: number) => {
		// A listing is not a toast. Anything taller than a few rows goes to the
		// transcript instead of the notice line, which has room for one: a listing
		// is worth scrolling back to anyway. Most commands already push their
		// listings with addDisplayMessage; this catches the ones that don't.
		if (noticeRows(text) > MAX_NOTICE_ROWS && addDisplayMessageRef.current) {
			addDisplayMessageRef.current({ role: "warning", content: text });
			return;
		}
		setNotice(text);
		noticeDurationRef.current = duration ?? 6000;
	}, []);

	// Pickers used after mount (slash commands, confirmBash) are modals of this
	// same screen, drawn from a request the bridge publishes — see
	// pickerBridge.ts. projectDeps.pickers
	// (the standalone onboarding pickers used by runStartup, pre-mount) is
	// intentionally overridden here for every post-mount consumer. One-off
	// status text (connection checks, trust prompts) routes through the same
	// notice line instead of a raw console.log that would corrupt the frame.
	const { pickers, request: modalRequest } = useModalBridge(showNotice);
	const projectDeps = useMemo(() => ({ ...result.projectDeps, pickers }), [result.projectDeps, pickers]);

	const [session] = useState(result.session);
	const [mcpResult, setMcpResult] = useState(result.mcpResult);
	const mcpResultRef = useRef(mcpResult);
	mcpResultRef.current = mcpResult;
	const [currentPersona, setCurrentPersona] = useState(result.persona);
	const [systemPrompt, setSystemPrompt] = useState(result.systemPrompt);
	const [skills, setSkills] = useState(result.skills);
	const [skillsPromptSuffix, setSkillsPromptSuffix] = useState(result.skillsPromptSuffix);
	const [contextFilesSuffix, setContextFilesSuffix] = useState(result.contextFilesSuffix);
	const [rulesSuffix, setRulesSuffix] = useState(result.rulesSuffix);
	const [rulesLazySuffix, setRulesLazySuffix] = useState(result.rulesLazySuffix);
	const [directoryRules, setDirectoryRules] = useState(result.directoryRules);
	// A resumed session starts from the rules it had latched, saved with it.
	const [activeAutoRules, setActiveAutoRules] = useState<Rule[]>(() =>
		restoreLatchedRules(result.session.activeRuleIds, result.directoryRules),
	);
	const [permissionMode, setPermissionMode] = useState(result.permissionMode);
	const [sshHosts, setSshHosts] = useState(result.sshHosts);
	const [projectTrusted, setProjectTrusted] = useState(result.projectTrusted);
	const [cwd, setCwd] = useState(result.cwd);
	const [reasoningMeta, setReasoningMeta] = useState(result.reasoningMeta);
	const [personaOptions, setPersonaOptions] = useState(result.personaOptions);
	const [personas, setPersonas] = useState(result.personas);
	const currentPersonaRef = useRef(currentPersona);
	currentPersonaRef.current = currentPersona;
	const [subagentPrompts] = useState(result.subagentPrompts);
	const [subagentModel, setSubagentModel] = useState(result.subagentModel);
	const [subagentModelProvider, setSubagentModelProvider] = useState(result.subagentModelProvider);
	const [planModel, setPlanModel] = useState(result.planModel);
	const [planModelProvider, setPlanModelProvider] = useState(result.planModelProvider);
	const [webToolsEnabled, setWebToolsEnabled] = useState(() => loadSettings().webTools === true);
	// Status bar segment configuration — persisted in settings, defaults to all
	// segments visible in registry order (see statusbar.ts).
	const [statusBar, setStatusBar] = useState<StatusBarConfig>(
		() => loadSettings().statusBar ?? defaultStatusBarConfig(),
	);
	const [header, setHeader] = useState<HeaderConfig>(() => loadSettings().header ?? defaultHeaderConfig());
	// Mode is per-session state: restored from the (possibly resumed) session
	// on startup, persisted into the session file on every toggle — so quitting
	// mid-planning resumes planning in THAT session, without leaking plan mode
	// into other projects the way the old global settings.mode did. Unset means
	// "build", the default. setPlanMode is the only setter handed out
	// (commands, /new, /sessions), so persistence can't be bypassed.
	const [planMode, setPlanModeState] = useState(() => session.mode === "plan");
	// In daemon mode the daemon caches the hydrated session, so a mode flip
	// saved locally would leave the daemon running the old mode. The ref is
	// populated once `agent` (and its setMode) exists below.
	const daemonModeSyncRef = useRef<(mode: "plan" | "build") => void>(() => {});
	const setPlanMode = useCallback(
		(v: boolean) => {
			setPlanModeState(v);
			session.mode = v ? "plan" : "build";
			saveSession(session);
			if (daemonUrl) daemonModeSyncRef.current(v ? "plan" : "build");
		},
		[session, daemonUrl],
	);
	const disabledTools = useMemo(() => {
		const s = new Set<string>();
		// Web tools respect the user's toggle in BOTH modes
		if (!webToolsEnabled) {
			s.add("web_search");
			s.add("web_fetch");
		}
		// Mode policy lives in core/plan.ts (modeDisabledTools) so it's testable
		// as data: plan mode blocks writers (bash stays advertised — the
		// executor gate restricts it to a read-only allowlist) and the
		// build-only plan tools; build mode blocks the plan-authoring tools.
		for (const name of modeDisabledTools(planMode)) s.add(name);
		return s;
	}, [webToolsEnabled, planMode]);
	// One object per session, mutated in place: an in-flight run captured this
	// reference at submit time, so /plan and /build toggles must land on the
	// same object for the loop's per-request system prompt sync to see them.
	const planState = useMemo(
		() =>
			createPlanState(cwd, session.id, {
				question: session.planQuestion,
				transition: session.planTransition,
				onChange: (question, transition) => {
					session.planQuestion = question;
					session.planTransition = transition;
					saveSession(session);
				},
			}),
		[cwd, session],
	);
	planState.enabled = planMode;
	// Per-phase model: planning can run on a stronger model than building.
	// session.model stays the main model; the override applies only while plan
	// mode is on, and everything downstream (run, system prompt Model line,
	// status bar) reports the model actually in use.
	const activeModel = planMode && planModel ? planModel : session.model;
	// Plan signal from the run (plan_done / question succeeded).
	// A ref, not state: it must not trigger renders mid-run — the dialog opens
	// only when the run settles (see the effect below), so the mode always
	// flips between runs and tool sets stay consistent.
	const planSignalRef = useRef<"done" | "question" | null>(null);
	// A decision flow clears one picker before its callback clears the pending
	// plan state. Keep that transient state from opening the same picker again.
	const decisionFlowActiveRef = useRef(false);
	// Armed by the "Keep planning" choice in the approval dialog: the next
	// non-command composer submission is wrapped as refine feedback. Lives in
	// the composer (not a modal) so multi-line paste and image paste work.
	const refineArmedRef = useRef(false);
	const onPlanSignal = useCallback((kind: "done" | "question") => {
		planSignalRef.current = kind;
	}, []);
	// Message to auto-submit once the mode flip has re-rendered. Submitting in
	// the same tick as setPlanMode would capture the OLD disabledTools/planState
	// closures (the /plan-desc race all over again) — the effect below fires
	// after the render that applied the new mode, so the run gets fresh config.
	const [pendingAutoSubmit, setPendingAutoSubmit] = useState<{ text: string; wantPlanMode: boolean } | null>(null);
	const confirmBash = useMemo(() => {
		const confirm = makeConfirmBash(pickers, permissionMode);
		return (command: string, reason: string, rule?: string, signal?: AbortSignal) => {
			if (permissionMode !== "bypass") notifyTerminal(`cast: approval needed: ${command}`);
			return confirm(command, reason, rule, signal);
		};
	}, [pickers, permissionMode]);

	// A server's form is asked on the same pickers; nothing to ask in a non-interactive run, so it is declined there.
	const askMcpForm = useCallback<AskMcpForm>(
		(server, params, signal) =>
			process.stdin.isTTY ? runMcpForm(pickers, server, params, signal) : Promise.resolve({ action: "decline" }),
		[pickers],
	);

	// Per-turn system prompt rebuild for sticky rules + @-mention.
	// Called by the loop at the start of each outer iteration.
	const rebuildSystemPrompt = useCallback(
		({ userText, contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
			// 1. Latch auto-attach rules whose globs match files now in context,
			//    and @-mentioned ones. A mention latches too: dropped on the next
			//    turn, the rule vanished from under a conversation built on it
			//    and the changed system prompt re-billed the whole history.
			const newRules = [
				...matchAutoRules(directoryRules, ctxFiles, rulesCwd(cwd)),
				...selectMentionedRules(directoryRules, userText),
			];
			const sticky = unionStickyRules(activeAutoRules, newRules);
			session.activeRuleIds = latchedRuleIds(sticky);
			if (sticky.length !== activeAutoRules.length) {
				setActiveAutoRules(sticky);
			}

			// 2. One block: always-apply + sticky rules (deduped). Must include
			//    always-apply rules unconditionally — see formatRulesForTurn.
			const rulesBlock = formatRulesForTurn(sticky, []);

			// 3. Nested AGENTS.md/CLAUDE.md for files touched this session — a
			//    subdirectory instruction file attaches once a file from its
			//    subtree enters context (per-file resolve model).
			//    Trust-gated like the cwd context file.
			const nestedContext = projectTrusted
				? formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles))
				: "";

			// 4. Build the full system prompt.
			const activePersona = currentPersonaRef.current;
			return buildSystemPrompt(
				activePersona,
				contextFilesSuffix + nestedContext,
				rulesBlock,
				rulesLazySuffix,
				// Rebuilt with the turn's context files so a `paths`-scoped skill is
				// offered only while a file it claims is in context.
				formatSkillsForPrompt(skills, activePersona.skills, ctxFiles),
				formatMcpForPrompt(mcpResult, activePersona.mcp),
				cwd,
				{
					model: activeModel,
					reasoningLevel: config.reasoningLevel,
					reasoningMeta,
					mode: planMode ? "plan" : "build",
				},
			);
		},
		[
			session,
			directoryRules,
			activeAutoRules,
			skills,
			mcpResult,
			contextFilesSuffix,
			rulesLazySuffix,
			cwd,
			projectTrusted,
			activeModel,
			config.reasoningLevel,
			reasoningMeta,
			planMode,
		],
	);

	const refreshPersonasForTurn = useCallback(async (): Promise<{
		persona: Persona;
		personas: Persona[];
		systemPrompt: string;
	}> => {
		const options = personaOptionsForCwd(cwd, projectTrusted);
		const nextPersonas = listPersonas(options);
		const nextPersona = findPersona(currentPersonaRef.current.name, options) ?? currentPersonaRef.current;
		currentPersonaRef.current = nextPersona;
		setPersonaOptions(options);
		setPersonas(nextPersonas);
		setCurrentPersona(nextPersona);
		const nextSystemPrompt = buildSystemPrompt(
			nextPersona,
			contextFilesSuffix,
			rulesSuffix,
			rulesLazySuffix,
			nextPersona.skills !== undefined ? formatSkillsForPrompt(skills, nextPersona.skills) : skillsPromptSuffix,
			formatMcpForPrompt(mcpResult, nextPersona.mcp),
			cwd,
			{
				model: activeModel,
				reasoningLevel: config.reasoningLevel,
				reasoningMeta,
				mode: planMode ? "plan" : "build",
			},
		);
		setSystemPrompt(nextSystemPrompt);
		return { persona: nextPersona, personas: nextPersonas, systemPrompt: nextSystemPrompt };
	}, [
		cwd,
		projectTrusted,
		contextFilesSuffix,
		rulesSuffix,
		rulesLazySuffix,
		skills,
		skillsPromptSuffix,
		mcpResult,
		activeModel,
		config.reasoningLevel,
		reasoningMeta,
		planMode,
	]);

	// Startup shows the screen first and connects MCP here: npx resolution, browser launches and remote handshakes took
	// seconds before the first frame. A /mcp change that landed meanwhile has already connected its own set, so a late
	// result for the initial one is dropped instead of overwriting it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, at mount
	useEffect(() => {
		if (!result.mcpResult.connectPending) return;
		void resolveMcpForCwd(projectDeps, cwd, projectTrusted, loadSettings().disabledMcpServers ?? []).then(
			async (connected) => {
				// Read from the ref, not from inside the updater: React runs an updater when it likes, often after this
				// line, so a flag set there was still false here and the connections just made were closed at once.
				if (mcpResultRef.current.connectPending === true) setMcpResult(connected);
				else await closeMcpConnections(connected.connections);
			},
		);
	}, []);

	// A persona the agent saved with activate: applied through /persona once
	// the turn it was saved in is over, the same as switching by hand.
	const pendingPersonaRef = useRef<{ name: string; mode: "new" | "here" } | null>(null);
	const agent = useAgentSession({
		onPersonaActivated: (name, mode) => {
			pendingPersonaRef.current = { name, mode };
		},
		onMcpChanged: () => {
			// The agent wrote an MCP config: connect what it added, so the list and the next turn have it now.
			void (async () => {
				const disabled = loadSettings().disabledMcpServers ?? [];
				const namesOf = (r: { allServerNames: string[] }) => r.allServerNames.slice().sort().join(",");
				const fresh = await resolveMcpForCwd(projectDeps, cwd, projectTrusted, disabled, /*skipConnect=*/ true);
				if (namesOf(fresh) === namesOf(mcpResult)) return;
				await closeMcpConnections(mcpResult.connections);
				setMcpResult(await resolveMcpForCwd(projectDeps, cwd, projectTrusted, disabled));
			})();
		},
		onCwdChanged: (next) => {
			if (next === cwd) return;
			session.cwd = next;
			setCwd(next);
		},
		onSkillsChanged: () => {
			void resolveSkillsForCwd(projectDeps, cwd, projectTrusted).then((next) => {
				setSkills(next.skills);
				setSkillsPromptSuffix(next.skillsPromptSuffix);
			});
		},
		session,
		config,
		cwd,
		systemPrompt,
		runner,
		backgroundTasks,
		permissionMode,
		mcpResult,
		confirmBash,
		askMcpForm,
		rebuildSystemPrompt,
		refreshPersonasForTurn,
		personas,
		currentPersona: currentPersona.name,
		subagentPrompts,
		subagentModel,
		subagentModelProvider,
		disabledTools,
		projectTrusted,
		noSkills: projectDeps.noSkills,
		cliSkillPaths: projectDeps.cliSkillPaths,
		skills,
		sshHosts,
		planState,
		onPlanSignal,
		modelOverride: planMode && planModel ? planModel : undefined,
		planModelProvider,
		daemonUrl,
		daemonToken,
	});
	// Running language servers for the status bar: this process's own, or the
	// daemon's when attached to one (the servers run where the agent does).
	const [lspServers, setLspServers] = useState<string[]>([]);
	const { daemonMode, runCommand } = agent;
	const showLsp = statusBar.visible.includes("lsp");
	useEffect(() => {
		// Off by default: only asked while the segment is on.
		if (!showLsp) return;
		let stopped = false;
		const poll = async () => {
			let ids: string[];
			try {
				ids = daemonMode
					? (((await runCommand("/lsp")) as { running?: Array<{ id: string }> } | undefined)?.running ?? []).map(
							(s) => s.id,
						)
					: lspStatus().running.map((s) => s.id);
			} catch {
				return;
			}
			const unique = [...new Set(ids)].sort();
			if (!stopped) setLspServers((prev) => (prev.join() === unique.join() ? prev : unique));
		};
		void poll();
		const timer = setInterval(() => void poll(), 5_000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [daemonMode, runCommand, showLsp]);
	addDisplayMessageRef.current = agent.addDisplayMessage;
	// Mode flips in daemon mode go over HTTP (setSessionMode on the daemon) —
	// populate the ref setPlanMode reads after the agent hook exists.
	daemonModeSyncRef.current = agent.setMode;
	const running = agent.status === "running";
	useEffect(() => {
		const pending = pendingPersonaRef.current;
		if (running || !pending) return;
		pendingPersonaRef.current = null;
		const flag = pending.mode === "new" ? "--new-session" : "--here";
		void handleInput(`/persona ${pending.name} ${flag}`, undefined, depsRef.current);
	}, [running]);
	// Recomputed when the transcript changes so a prompt is recallable on the
	// turn right after it was sent.
	const promptHistory = useMemo(() => submittedPrompts(agent.messages), [agent.messages]);
	const canSubmit = useCallback(
		(text: string) => {
			if (!agent.daemonConnected) {
				showNotice("[Daemon disconnected — message kept in the composer until it reconnects]");
				return false;
			}
			if (agent.status !== "running") return true;
			if (canSubmitDuringRun(text)) return true;
			showNotice("[Agent running — Esc stops the turn, /queue runs this after it]");
			return false;
		},
		[agent.daemonConnected, agent.status, showNotice],
	);
	const submitRef = useRef(agent.submit);
	submitRef.current = agent.submit;

	// Deferred auto-submit for mode-transition dialogs: fires only after the
	// render that applied the requested mode, so the run picks up the fresh
	// disabledTools/planState instead of the pre-flip closures.
	useEffect(() => {
		if (!pendingAutoSubmit || planMode !== pendingAutoSubmit.wantPlanMode) return;
		const { text } = pendingAutoSubmit;
		setPendingAutoSubmit(null);
		void submitRef.current(text);
	}, [pendingAutoSubmit, planMode]);

	// Decision dialogs open only after a run settles: plan_done → approval;
	// question → picker.
	useEffect(() => {
		if (agent.status === "running" || modalRequest || decisionFlowActiveRef.current) return;
		const kind =
			planSignalRef.current ??
			agent.pendingPlanTransition?.kind ??
			readPlanTransition(planState)?.kind ??
			// A reattaching thin client learns of a waiting question from the
			// daemon's state, with no signal event and no local planState.
			(agent.pendingQuestion || readPlanQuestion(planState) ? "question" : null);
		if (!kind) return;
		planSignalRef.current = null;
		if (kind === "done" && planMode) {
			decisionFlowActiveRef.current = true;
			void (async () => {
				try {
					// Full path in the title: terminals make it clickable, so the user
					// can open the plan in their editor straight from the dialog.
					const planPath = readActivePlan(planState).path;
					const choice = await pickers.pickOption(
						[
							{ value: "continue", label: "Continue planning" },
							{ value: "implement", label: "Approve and implement" },
							{ value: "clean", label: "Approve and implement in clean context" },
						],
						{ title: planPath ? `Plan ready: ${planPath}` : "Plan ready. What next?" },
					);
					if (choice === "implement" || choice === "clean") {
						session.todos = createPlanTodos(planState);
						// Daemon mode owns planState/context on the daemon side — the
						// approval (which also creates the daemon's todos) and the
						// clean-context reset go over HTTP, not local planState.
						if (daemonUrl) {
							agent.approvePlan();
							const originalTask = choice === "clean" ? await agent.cleanDaemonContext() : undefined;
							setPlanMode(false);
							setPendingAutoSubmit({
								text:
									choice === "clean"
										? `<system-reminder>Clean build context. Original task: ${originalTask ?? "Use the approved plan as the task definition."}</system-reminder>\n\nThe plan is approved. Implement it step by step.`
										: "The plan is approved. Implement it step by step.",
								wantPlanMode: false,
							});
						} else {
							resolvePlanTransition(planState);
							const originalTask = choice === "clean" ? resetSessionContext(session) : undefined;
							if (choice === "clean") saveSession(session);
							setPlanMode(false);
							setPendingAutoSubmit({
								text:
									choice === "clean"
										? `<system-reminder>Clean build context. Original task: ${originalTask ?? "Use the approved plan as the task definition."}</system-reminder>\n\nThe plan is approved. Implement it step by step.`
										: "The plan is approved. Implement it step by step.",
								wantPlanMode: false,
							});
						}
					} else if (choice === "continue") {
						if (daemonUrl) {
							agent.approvePlan();
						} else {
							resolvePlanTransition(planState);
						}
						// Feedback goes through the regular composer, not a modal text
						// box: the composer supports multi-line paste, image paste, and
						// history. handleSubmit wraps the next non-command message as
						// the refine turn so the model knows to update the plan.
						refineArmedRef.current = true;
						showNotice("[Refining — type your feedback below; it goes back to the planner]");
					} else {
						// Esc on the dialog: stay in plan mode, nothing submitted.
						showNotice("[Staying in plan mode — describe what to change]");
					}
				} finally {
					decisionFlowActiveRef.current = false;
				}
			})();
		} else if (kind === "question") {
			decisionFlowActiveRef.current = true;
			void (async () => {
				try {
					// Daemon mode stashes the question from the SSE tool_end event
					// (agent.pendingQuestion); local mode reads it off planState,
					// which only the local loop populates.
					const question = daemonUrl ? agent.pendingQuestion : readPlanQuestion(planState);
					if (!question) {
						return;
					}
					const result = await resolvePlanQuestionWithPicker(question, pickers);
					if (!result) {
						showNotice("[Decision still needed — choose an option when ready]");
						return;
					}
					const { answers, sources } = result;
					if (daemonUrl) {
						// The daemon owns the pending question — answering over HTTP
						// clears ITS state and starts the follow-up turn with the
						// rendered answers (answerQuestion in web/bridge.ts).
						agent.answerQuestion(answers);
					} else {
						resolvePlanQuestion(planState);
						setPendingAutoSubmit({
							text: question.questions
								.map((item, index) => {
									const ans = answers[index];
									if (sources[index] === "free-form") {
										return `Question: ${item.question} Answer: ${ans}`;
									}
									if (Array.isArray(ans)) {
										const labels = ans
											.map((v) => item.options.find((option) => option.value === v)?.label ?? v)
											.join(", ");
										return `Question: ${item.question} Answer: ${labels}`;
									}
									const selected = item.options.find((option) => option.value === ans);
									return `Question: ${item.question} Answer: ${selected?.label ?? ans}`;
								})
								.join("\n"),
							wantPlanMode: planMode,
						});
					}
				} finally {
					decisionFlowActiveRef.current = false;
				}
			})();
		}
	}, [
		agent.status,
		agent.pendingQuestion,
		agent.pendingPlanTransition?.kind,
		agent.answerQuestion,
		agent.approvePlan,
		agent.cleanDaemonContext,
		modalRequest,
		planMode,
		pickers,
		setPlanMode,
		showNotice,
		planState,
		session,
		daemonUrl,
	]);

	// Another TUI can answer the daemon-owned decision while this client has
	// its picker open. Resolve that picker quietly so it cannot submit a stale
	// choice after the daemon has already advanced the session.
	useEffect(() => {
		if (
			!daemonUrl ||
			!decisionFlowActiveRef.current ||
			!modalRequest ||
			agent.pendingQuestion ||
			agent.pendingPlanTransition
		) {
			return;
		}
		if (modalRequest.kind === "status") return;
		modalRequest.resolve(null);
	}, [agent.pendingPlanTransition, agent.pendingQuestion, daemonUrl, modalRequest]);

	useEffect(() => {
		if (initialPrompt) {
			void submitRef.current(initialPrompt);
		}
	}, [initialPrompt]);

	useEffect(() => {
		if (initialPrompt || !isReleaseInstall()) return;
		fetchLatestVersion()
			.then((latest) => {
				if (latest && isNewerVersion(version, latest)) {
					showNotice(`[cast v${latest} available — run "cast upgrade" to update]`);
				}
			})
			.catch(() => {});
	}, [version, initialPrompt, showNotice]);

	useEffect(() => {
		// Don't dismiss out from under an open modal — e.g. the trust prompt's
		// explanation shouldn't vanish while the user is still deciding.
		if (!notice || modalRequest) return;
		const duration = noticeDurationRef.current;
		if (duration <= 0) return;
		const id = setTimeout(() => setNotice(null), duration);
		return () => clearTimeout(id);
	}, [notice, modalRequest]);

	// Stable deps ref — handleInput reads the latest values at call time
	// instead of recreating handleSubmit on every state change.
	const depsRef = useRef({
		agent,
		session,
		config,
		running,
		onQuit,
		showNotice,
		cwd,
		setCwd,
		currentPersona,
		setCurrentPersona,
		skills,
		setSkills,
		skillsPromptSuffix,
		setSkillsPromptSuffix,
		contextFilesSuffix,
		setContextFilesSuffix,
		rulesSuffix,
		setRulesSuffix,
		rulesLazySuffix,
		setRulesLazySuffix,
		directoryRules,
		setDirectoryRules,
		activeAutoRules,
		setActiveAutoRules,
		systemPrompt,
		setSystemPrompt,
		mcpResult,
		setMcpResult,
		permissionMode,
		setPermissionMode,
		projectTrusted,
		setProjectTrusted,
		projectDeps,
		pickers,
		reasoningMeta,
		setReasoningMeta,
		personaOptions,
		setPersonaOptions,
		subagentModel,
		setSubagentModel,
		subagentModelProvider,
		setSubagentModelProvider,
		webToolsEnabled,
		setWebToolsEnabled,
		planMode,
		setPlanMode,
		planModel,
		setPlanModel,
		planModelProvider,
		setPlanModelProvider,
		sshHosts,
		setSshHosts,
		onThemeChange,
		onRepaintHistory,
		statusBar,
		setStatusBar,
		header,
		setHeader,
	});
	depsRef.current = {
		agent,
		session,
		config,
		running,
		onQuit,
		showNotice,
		cwd,
		setCwd,
		currentPersona,
		setCurrentPersona,
		skills,
		setSkills,
		skillsPromptSuffix,
		setSkillsPromptSuffix,
		contextFilesSuffix,
		setContextFilesSuffix,
		rulesSuffix,
		setRulesSuffix,
		rulesLazySuffix,
		setRulesLazySuffix,
		directoryRules,
		setDirectoryRules,
		activeAutoRules,
		setActiveAutoRules,
		systemPrompt,
		setSystemPrompt,
		mcpResult,
		setMcpResult,
		permissionMode,
		setPermissionMode,
		projectTrusted,
		setProjectTrusted,
		projectDeps,
		pickers,
		reasoningMeta,
		setReasoningMeta,
		personaOptions,
		setPersonaOptions,
		subagentModel,
		setSubagentModel,
		subagentModelProvider,
		setSubagentModelProvider,
		webToolsEnabled,
		setWebToolsEnabled,
		planMode,
		setPlanMode,
		planModel,
		setPlanModel,
		planModelProvider,
		setPlanModelProvider,
		sshHosts,
		setSshHosts,
		onThemeChange,
		onRepaintHistory,
		statusBar,
		setStatusBar,
		header,
		setHeader,
	};

	// PageUp in the composer routes here (the history.older binding) —
	// same load + replay flow as the /older command.
	const onLoadOlder = useCallback(async () => {
		if (agent.loadOlder()) {
			await onRepaintHistory();
			showNotice("[Loaded older history — scroll up to read it]");
		} else {
			showNotice("[No older history — this is the start of the session]");
		}
	}, [agent, onRepaintHistory, showNotice]);

	const handleSubmit = useCallback(async (text: string, options?: { otherMode?: boolean }) => {
		let input = text;
		// Refine armed (see the approval dialog): the next real message is the
		// plan feedback — wrap it so the model updates the plan instead of
		// treating it as a new request. Slash commands pass through without
		// disarming (running /model etc. first shouldn't eat the refine).
		// Leaving plan mode by any other path cancels the pending refine.
		if (refineArmedRef.current) {
			if (!depsRef.current.planMode) {
				refineArmedRef.current = false;
			} else if (!text.trim().startsWith("/")) {
				refineArmedRef.current = false;
				input = `Refine the plan based on this feedback, update the plan file with edit/write, then call plan_done again:\n\n${text.trim()}`;
			}
		}
		// Attach any image file path in the message inline (a Ctrl+G clipboard
		// save, or a file copied in the file manager and pasted via Ctrl+V) —
		// the same PendingImage pipeline the web client uses, instead of
		// leaving the model to guess it should `read` the bare path.
		const images = await readImageFilesFromText(input);
		await handleInput(input, images.length > 0 ? images : undefined, depsRef.current, options);
	}, []);

	return {
		agent,
		notice,
		pickers,
		modalRequest,
		session,
		cwd,
		skills,
		mcpResult,
		running,
		statusBar,
		header,
		currentPersona,
		planMode,
		activeModel,
		planModel,
		config,
		lspServers,
		promptHistory,
		canSubmit,
		handleSubmit,
		onLoadOlder,
		showNotice,
		permissionMode,
	};
}

export type AppModel = ReturnType<typeof useAppModel>;
