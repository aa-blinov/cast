import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { restoreCheckpoint } from "../core/checkpoint.ts";
import { reminderStateFromPlan } from "../core/compaction-reminder.ts";
import { type AppConfig, probeProvider, resolveProvider, runOnboardingCheck } from "../core/config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "../core/context-files.ts";
import { runHooksForEvent } from "../core/hooks.ts";
import { compactSessionMessages, PLAN_COMPACTION_PROMPT, runMemoryMaintenanceAgent } from "../core/loop.ts";
import { closeMcpConnections, formatMcpForPrompt, type McpSetupResult, mcpServerToolBlurbs } from "../core/mcp.ts";
import {
	cancelAutomaticMemoryRun,
	distillProjectMemory,
	dreamProjectMemory,
	listAutomaticMemoryRuns,
} from "../core/memory.ts";
import { findPersona, type LoadPersonasOptions, type Persona } from "../core/personas.ts";
import { createPlanState, readActivePlan } from "../core/plan.ts";
import {
	buildSystemPrompt,
	discoverSkillsForCwd,
	listHooksForCwdSettings,
	listUninstallableMcpServers,
	type ProjectResolverDeps,
	personaOptionsForCwd,
	removeMcpServerFromDisk,
	resolveHooksForCwd,
	resolveMcpForCwd,
	resolveProjectTrustForCwd,
	resolveRulesForCwd,
	resolveSkillsForCwd,
} from "../core/project.ts";
import { getModelsCache } from "../core/readline.ts";
import { formatRuleInvocation, type Rule } from "../core/rules.ts";
import {
	addUsage,
	countTurnMessages,
	createSession,
	dropLastCheckpoint,
	listSessionSummaries,
	loadSession,
	recordCompaction,
	type SessionState,
	saveSession,
	updateSessionIdentity,
} from "../core/session.ts";
import {
	isMemoryWriteEnabled,
	loadSettings,
	type PermissionMode,
	type Provider,
	type StatusBarConfig,
	updateSettings,
} from "../core/settings.ts";
import {
	formatSkillsForPrompt,
	isUninstallableSkill,
	renderSkillInvocation,
	type Skill,
	uninstallUserSkill,
} from "../core/skills.ts";
import { skillsShInstall, skillsShListAvailable, skillsShSearch, skillsShUninstall } from "../core/skills-sh.ts";
import { resolveSshHosts, type SshHost, saveSshConfig, scanSshKeys, validateKeyPermissions } from "../core/ssh.ts";
import { cancelActiveDecxprQuery, suspendAndRun } from "../core/stdin-manager.ts";
import {
	buildReasoningParams,
	getDefaultReasoningLevel,
	getReasoningOptionsForFormat,
	type ModelReasoningMeta,
	type ReasoningParams,
	resolveReasoningFormat,
} from "../core/vendors.ts";
import { createSessionWorktree, listWorktrees, removeSessionWorktree } from "../core/worktree.ts";
import {
	formatSkillPickLabel,
	selectMcpServers,
	selectModel,
	selectPermissionMode,
	selectPersona,
	selectReasoningFormat,
	selectReasoningLevel,
	selectSession,
	selectSkills,
} from "../pickers/domain.ts";
import type { Pickers, PickOption } from "../pickers/types.ts";
import { buildGoalPrompt, parseGoalInput, REVIEW_PROMPT } from "../server/commands.ts";
import { TUI_KEYBINDINGS } from "./input/keybindings.ts";
import { getStatusBarSegments, SEGMENT_MAX_WIDTH, type SegmentContext, type StatusBarSegment } from "./statusbar.tsx";
import { ALL_THEMES, getActiveTheme, setActiveTheme } from "./themes/index.ts";
import type { PendingImage, UseAgentSession } from "./useAgentSession.ts";

interface ModelWithReasoningSelection {
	model: string;
	reasoningMeta?: ModelReasoningMeta;
	reasoningSupported?: boolean;
	contextWindow?: number;
	reasoningLevel: string;
	reasoningParams: ReasoningParams;
}

async function selectModelWithReasoning(
	config: AppConfig,
	pickers: Pickers,
	current?: string,
	providerOverride?: { baseURL: string; apiKey: string },
): Promise<ModelWithReasoningSelection | null> {
	// Reasoning selection is part of model selection. Keep it on a temporary
	// config so Escape can cancel the whole transition without leaving a new
	// model, provider, or reasoning payload partially applied.
	const candidate = { ...config };
	const selection = await selectModel(candidate, pickers, current, undefined, providerOverride);
	if (!selection) return null;
	const selected = await selectReasoningLevel(
		candidate,
		selection.model,
		pickers,
		selection.reasoningMeta,
		selection.reasoningSupported,
	);
	if (!selected) return null;
	return {
		model: selection.model,
		reasoningMeta: selection.reasoningMeta,
		reasoningSupported: selection.reasoningSupported,
		contextWindow: selection.contextWindow,
		reasoningLevel: candidate.reasoningLevel,
		reasoningParams: candidate.reasoningParams,
	};
}

const WHITESPACE_SPLIT_RE = /\s+/;
const WORKTREE_REMOVE_PREFIX_RE = /^(?:remove|rm)\s*/;
const WORKTREE_FORCE_FLAG_RE = /(^|\s)(--force|-f)(\s|$)/;
const WORKTREE_FORCE_STRIP_RE = /(^|\s)(--force|-f)(?=\s|$)/g;
const MEMORY_BUDGET_COMMAND_RE = /^\/memory budget (\d+)$/;
const MEMORY_FLOOR_COMMAND_RE = /^\/memory floor (0(?:\.\d+)?|1(?:\.0)?)$/;
const MEMORY_RECONCILE_COMMAND_RE = /^\/memory reconcile (on|off)$/;
const MEMORY_CHECKPOINT_FORK_COMMAND_RE = /^\/memory checkpoint fork (on|off)$/;
const MEMORY_CHECKPOINT_THRESHOLDS_COMMAND_RE = /^\/memory checkpoint thresholds (.+)$/;
const MEMORY_CHECKPOINT_RESERVED_COMMAND_RE = /^\/memory checkpoint reserved (\d+)$/;
const MEMORY_CHECKPOINT_CAPS_COMMAND_RE = /^\/memory checkpoint caps (.+)$/;
const MEMORY_AUTO_TOGGLE_COMMAND_RE = /^\/memory (dream|distill) (on|off)$/;
const MEMORY_AUTO_INTERVAL_COMMAND_RE = /^\/memory (dream|distill) interval (\d+)$/;
const MEMORY_CANCEL_RUN_COMMAND_RE = /^\/memory cancel ([a-f0-9-]+)$/;

/**
 * Slash commands shown in the Composer's autocomplete palette.
 *
 * `takesArgs` marks the commands that need an argument *typed inline* after the
 * name — picking those from the palette fills the name and waits for input.
 * Every other command runs standalone or opens its own picker, so the palette
 * runs it immediately on Enter instead of making the user confirm with a second
 * keystroke (see Composer's selectCommand).
 */
// Rendered verbatim by the composer's command palette — keep alphabetical by
// name (enforced by a test) so the list is scannable as it grows.
export const SLASH_COMMANDS: Array<{ name: string; description: string; takesArgs?: boolean }> = [
	{ name: "/abort", description: "Abort the current run" },
	{ name: "/build", description: "Exit plan mode, restore full toolset" },
	{ name: "/clear", description: "Clear context (and save)" },
	{ name: "/compact", description: "Compact context now" },
	{ name: "/continue", description: "Resume the most recent session" },
	{ name: "/copy", description: "Copy last assistant response" },
	{ name: "/current", description: "Show all status bar data" },
	{ name: "/distill", description: "Package a repeated workflow as a reusable project artifact" },
	{ name: "/dream", description: "Consolidate durable project memory" },
	{ name: "/evolve", description: "Propose reusable skills for this project from the session" },
	{ name: "/exit", description: "Save and exit (alias for /quit)" },
	{ name: "/fork", description: "Fork the current conversation into a new session" },
	{ name: "/goal", description: "Work toward a goal autonomously until done — goal text", takesArgs: true },
	{ name: "/help", description: "Show this command list" },
	{ name: "/hooks", description: "List configured hooks" },
	{ name: "/hooks disable", description: "Disable a hook — id", takesArgs: true },
	{ name: "/hooks enable", description: "Enable a hook — id", takesArgs: true },
	{ name: "/hooks help", description: "Show hooks command cheat sheet" },
	{ name: "/keys", description: "List all keybindings" },
	{ name: "/mcp", description: "Toggle MCP servers on/off" },
	{ name: "/mcp disable", description: "Disable one server — name", takesArgs: true },
	{ name: "/mcp enable", description: "Enable one server — name", takesArgs: true },
	{ name: "/mcp help", description: "Show MCP command cheat sheet" },
	{ name: "/mcp list", description: "List configured MCP servers" },
	{
		name: "/mcp uninstall",
		description: "Uninstall — picker, or server name",
		takesArgs: true,
	},
	{ name: "/memory", description: "Toggle durable project memory" },
	{ name: "/memory budget", description: "Set automatic memory prompt token budget", takesArgs: true },
	{ name: "/memory checkpoint caps", description: "Set per-section rebuild context token caps", takesArgs: true },
	{ name: "/memory checkpoint reserved", description: "Set checkpoint reserved token buffer", takesArgs: true },
	{ name: "/memory checkpoint thresholds", description: "Set checkpoint trigger percentages", takesArgs: true },
	{ name: "/memory distill", description: "Toggle automatic workflow distillation", takesArgs: true },
	{ name: "/memory dream", description: "Toggle automatic memory consolidation", takesArgs: true },
	{ name: "/memory floor", description: "Set memory search score floor", takesArgs: true },
	{ name: "/memory reconcile", description: "Toggle file reconciliation before memory search", takesArgs: true },
	{ name: "/memory runs", description: "List automatic memory background runs" },
	{ name: "/memory write", description: "Toggle background memory writing", takesArgs: true },
	{ name: "/model", description: "Show or change model" },
	{ name: "/new", description: "Start a new session" },
	{ name: "/older", description: "Load older history for this session" },
	{ name: "/permissions", description: "Change permission mode (bash + write)" },
	{ name: "/persona", description: "Show or change persona" },
	{ name: "/plan", description: "Enter plan mode (explore + plan only)" },
	{ name: "/plan-model", description: "Show or change the plan-mode model" },
	{ name: "/plan-model-provider", description: "Set provider for plan-mode model", takesArgs: true },
	{ name: "/provider", description: "Switch / add / delete providers" },
	{ name: "/q", description: "Alias for /queue", takesArgs: true },
	{ name: "/qr", description: "Alias for /queue-reset" },
	{ name: "/queue", description: "Queue a message for after the run", takesArgs: true },
	{ name: "/queue-reset", description: "Clear the message queue" },
	{ name: "/quit", description: "Save and exit" },
	{ name: "/reasoning", description: "Change reasoning level" },
	{ name: "/reasoning-display", description: "Toggle reasoning blocks in the transcript" },
	{ name: "/reasoning-format", description: "Set provider reasoning protocol" },
	{ name: "/reload", description: "Reload skills, rules, MCP, and personas for cwd" },
	{ name: "/repo", description: "Show cwd and git branch" },
	{ name: "/review", description: "Ask the agent to review and verify its own work" },
	{ name: "/rule:", description: "Invoke a rule by name", takesArgs: true },
	{ name: "/rules", description: "List loaded rules" },
	{ name: "/s", description: "Alias for /steer", takesArgs: true },
	{ name: "/sessions", description: "List / switch / delete sessions" },
	{ name: "/skills", description: "Toggle skills on/off" },
	{ name: "/skills disable", description: "Disable one skill — name", takesArgs: true },
	{ name: "/skills enable", description: "Enable one skill — name", takesArgs: true },
	{ name: "/skills help", description: "Show skills command cheat sheet" },
	{ name: "/skills list", description: "List loaded skills" },
	{
		name: "/skills uninstall",
		description: "Uninstall — picker, or skill name (cast/agents dirs)",
		takesArgs: true,
	},
	{ name: "/skills-sh", description: "skills.sh — install / search / uninstall universal skills" },
	{
		name: "/skills-sh install",
		description: "Install — owner/repo --skill name (a pasted npx line works too)",
		takesArgs: true,
	},
	{ name: "/skills-sh list-available", description: "List a repo's skills — owner/repo", takesArgs: true },
	{ name: "/skills-sh search", description: "Search skills.sh — query", takesArgs: true },
	{ name: "/skills-sh uninstall", description: "Uninstall a skills.sh skill — name", takesArgs: true },
	{ name: "/ssh", description: "Manage SSH hosts (list, add, remove)" },
	{ name: "/statusbar", description: "Toggle and reorder status bar segments" },
	{ name: "/steer", description: "Inject a message while running", takesArgs: true },
	{ name: "/subagent-model", description: "Show or change subagent model" },
	{ name: "/subagent-model-provider", description: "Set provider for subagent model", takesArgs: true },
	{ name: "/theme", description: "Change color theme" },
	{ name: "/turn-cap", description: "Show/set the per-turn iteration safety cap — N or reset", takesArgs: true },
	{ name: "/undo", description: "Undo last turn (restore files and context)" },
	{ name: "/web", description: "Toggle web search & fetch tools" },
	{ name: "/web-fetch-provider", description: "Switch web_fetch backend (Jina Reader / local)" },
	{ name: "/web-search-provider", description: "Switch web_search backend (DuckDuckGo / Tavily / Brave)" },
	{ name: "/worktree", description: "Switch into a git worktree — name", takesArgs: true },
	{ name: "/worktree list", description: "List all active worktrees" },
	{
		name: "/worktree remove",
		description: "Remove a worktree — name [--force to discard uncommitted work]",
		takesArgs: true,
	},
];

export interface CommandDeps {
	agent: UseAgentSession;
	session: SessionState;
	config: AppConfig;
	running: boolean;
	onQuit: () => void;
	showNotice: (text: string, duration?: number) => void;
	cwd: string;
	setCwd: (cwd: string) => void;
	currentPersona: Persona;
	setCurrentPersona: (p: Persona) => void;
	personaOptions: LoadPersonasOptions;
	setPersonaOptions: (o: LoadPersonasOptions) => void;
	skills: Skill[];
	setSkills: (s: Skill[]) => void;
	skillsPromptSuffix: string;
	setSkillsPromptSuffix: (s: string) => void;
	contextFilesSuffix: string;
	setContextFilesSuffix: (s: string) => void;
	rulesSuffix: string;
	setRulesSuffix: (s: string) => void;
	rulesLazySuffix: string;
	setRulesLazySuffix: (s: string) => void;
	directoryRules: Rule[];
	setDirectoryRules: (r: Rule[]) => void;
	activeAutoRules: Rule[];
	setActiveAutoRules: (r: Rule[]) => void;
	systemPrompt: string;
	setSystemPrompt: (s: string) => void;
	mcpResult: McpSetupResult;
	setMcpResult: (m: McpSetupResult) => void;
	permissionMode: PermissionMode;
	setPermissionMode: (m: PermissionMode) => void;
	projectTrusted: boolean;
	setProjectTrusted: (t: boolean) => void;
	projectDeps: ProjectResolverDeps;
	pickers: Pickers;
	sshHosts: SshHost[];
	setSshHosts: (hosts: SshHost[]) => void;
	reasoningMeta: ModelReasoningMeta | undefined;
	setReasoningMeta: (m: ModelReasoningMeta | undefined) => void;
	subagentModel?: string;
	setSubagentModel: (m: string | undefined) => void;
	subagentModelProvider?: string;
	setSubagentModelProvider: (p: string | undefined) => void;
	webToolsEnabled: boolean;
	setWebToolsEnabled: (v: boolean) => void;
	planMode: boolean;
	setPlanMode: (v: boolean) => void;
	/** Model used while plan mode is active; undefined falls back to session.model. */
	planModel?: string;
	setPlanModel: (m: string | undefined) => void;
	planModelProvider?: string;
	setPlanModelProvider: (p: string | undefined) => void;
	onThemeChange?: () => void;
	/** Force a full clear + <Static> replay after history was prepended. */
	onRepaintHistory?: () => void | Promise<void>;
	statusBar: StatusBarConfig;
	setStatusBar: (s: StatusBarConfig) => void;
}

/**
 * Helper: rebuild system prompt and push it. Takes explicit overrides rather
 * than reading `deps.currentPersona`/`deps.rulesSuffix`/etc. back — those come
 * from a `deps` object built once per `handleInput` call from that render's
 * state, so a `setCurrentPersona(x)` a few lines above doesn't change what
 * `deps.currentPersona` reads for the rest of *this* call (state updates
 * apply on the next render, not synchronously). Reading them back here used
 * to rebuild the prompt from the value being replaced, so e.g. /persona took
 * a full extra round-trip to actually change what the model saw.
 */
function rebuildSystemPrompt(
	deps: CommandDeps,
	cwd: string,
	overrides: {
		persona?: Persona;
		contextFilesSuffix?: string;
		rulesSuffix?: string;
		rulesLazySuffix?: string;
		skillsPromptSuffix?: string;
	} = {},
): void {
	const activePersona = overrides.persona ?? deps.currentPersona;
	// Same "recompute from the raw list when the persona restricts it" shape
	// as bridge.ts's computeSystemPrompt — keeps the described skill/MCP
	// catalog in sync with what loop.ts actually lets this persona call.
	const skillsSuffix =
		overrides.skillsPromptSuffix ??
		(activePersona.skills !== undefined
			? formatSkillsForPrompt(deps.skills, activePersona.skills)
			: deps.skillsPromptSuffix);
	deps.setSystemPrompt(
		buildSystemPrompt(
			activePersona,
			overrides.contextFilesSuffix ?? deps.contextFilesSuffix,
			overrides.rulesSuffix ?? deps.rulesSuffix,
			overrides.rulesLazySuffix ?? deps.rulesLazySuffix,
			skillsSuffix,
			formatMcpForPrompt(deps.mcpResult, activePersona.mcp),
			cwd,
			{
				// The Model line reports the model actually in use — in plan mode
				// with an override that's the plan model, not session.model.
				model: deps.planMode && deps.planModel ? deps.planModel : deps.session.model,
				reasoningLevel: deps.config.reasoningLevel,
				reasoningMeta: deps.reasoningMeta,
				mode: deps.planMode ? "plan" : "build",
			},
		),
	);
}

/** Helper: warning + persist for permission mode changes (matches basic). */
async function applyPermissionMode(deps: CommandDeps, newMode: PermissionMode): Promise<void> {
	if (newMode === "bypass" && deps.permissionMode !== "bypass") {
		const picked = await deps.pickers.pickOption(
			[
				{ value: true, label: "Yes, enable bypass (no confirmation for any bash command)" },
				{ value: false, label: "Cancel" },
			],
			{ title: "Warning: bypass disables confirmation for rm -rf, sudo, force-push, ... — saved to settings.json" },
		);
		if (picked !== true) {
			deps.showNotice("Cancelled — staying in default mode.");
			return;
		}
	}
	deps.setPermissionMode(newMode);
	updateSettings({ permissionMode: newMode });
	deps.showNotice(`Permission mode: ${newMode}`);
}

/** Observation-only, fire-and-forget — a skill/rule name expanding into its actual prompt content. */
function fireUserPromptExpansion(deps: CommandDeps, name: string): void {
	const hooks = resolveHooksForCwd(deps.cwd, deps.projectTrusted);
	if (Object.keys(hooks).length === 0) return;
	void runHooksForEvent(hooks, {
		event: "UserPromptExpansion",
		matchTarget: name,
		cwd: deps.cwd,
		payload: { command_name: name },
	});
}

async function reloadSkillsAfterChange(deps: CommandDeps): Promise<void> {
	const { skills, skillsPromptSuffix } = await resolveSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	deps.setSkills(skills);
	deps.setSkillsPromptSuffix(skillsPromptSuffix);
	rebuildSystemPrompt(deps, deps.cwd, { skillsPromptSuffix });
}

const SKILLS_HELP = `Skills — pick a row from the /skills palette, or type:

  /skills                      Toggle on/off (multi-select, like /mcp)
  /skills list                 What's loaded (source + enabled)
  /skills enable|disable NAME
  /skills uninstall            Pick global/project skill to remove
  /skills uninstall NAME

Add skills via ~/.cast/skills/, .cast/skills/, .agents/skills/ (npx skills add),
or --skill.
Builtin skills: disable them — /skills uninstall does not remove them.`;

const HOOKS_HELP = `Hooks — shell/HTTP commands that fire on lifecycle events:

  /hooks                       List merged hooks (global/project) + status
  /hooks enable|disable ID     Toggle one — id shown by /hooks
  /hooks help                  This cheat sheet

Config: ~/.cast/hooks.json (global), .cast/hooks.json (project, requires trust),
See docs/hooks.md for the event list
and JSON shape (same as Claude Code / Grok Build).`;

const MCP_HELP = `MCP — pick a row from the /mcp palette, or type:

  /mcp                         Toggle servers on/off (multi-select)
  /mcp list                    Configured servers + status
  /mcp enable|disable NAME
  /mcp uninstall               Pick server to remove from mcp.json
  /mcp uninstall NAME

Add servers via ~/.cast/mcp.json, .cast/mcp.json, or --mcp.
CLI --mcp paths are not removable with /mcp uninstall.`;

async function confirmUninstall(deps: CommandDeps, title: string, yesLabel: string): Promise<boolean> {
	const confirm = await deps.pickers.pickOption(
		[
			{ value: true, label: yesLabel },
			{ value: false, label: "Cancel" },
		],
		{ title },
	);
	if (confirm !== true) {
		deps.showNotice("[Cancelled]");
		return false;
	}
	return true;
}

async function applySkillUninstall(deps: CommandDeps, skill: Skill): Promise<void> {
	uninstallUserSkill(skill);
	const disabled = (loadSettings().disabledSkills ?? []).filter((n) => n !== skill.name);
	updateSettings({ disabledSkills: disabled.length > 0 ? disabled : undefined });
	await reloadSkillsAfterChange(deps);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Uninstalled skill ${skill.name} (${skill.source})]`,
	});
}

async function uninstallSkillInteractive(deps: CommandDeps): Promise<void> {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	const removable = discovered.filter(isUninstallableSkill);
	if (removable.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content: "No uninstallable skills (.cast / .agents only). Builtin: disable it; --skill paths are CLI-owned.",
		});
		return;
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	const options: PickOption<string>[] = [
		...removable.map((s) => ({
			value: s.name,
			label: `${s.name} (${s.source}${disabled.has(s.name) ? ", disabled" : ""})`,
			description: s.description,
		})),
	].sort((a, b) => a.value.localeCompare(b.value));
	const firstSelectable = options.findIndex((o) => !o.locked);
	const picked = await deps.pickers.pickOption(options, {
		title: "Uninstall which skill?",
		defaultIndex: firstSelectable >= 0 ? firstSelectable : 0,
	});
	if (!picked) {
		deps.showNotice("[Cancelled]");
		return;
	}
	const skill = removable.find((s) => s.name === picked);
	if (!skill) {
		deps.showNotice(`[Skill "${picked}" is not removable from here]`);
		return;
	}
	if (
		!(await confirmUninstall(
			deps,
			`Uninstall skill "${skill.name}" (${skill.source})?`,
			`Yes, uninstall "${skill.name}"`,
		))
	) {
		return;
	}
	await applySkillUninstall(deps, skill);
}

async function setSkillEnabled(deps: CommandDeps, name: string, enable: boolean): Promise<void> {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	const skill = discovered.find((s) => s.name === name);
	if (!skill) {
		deps.showNotice(`[No skill named "${name}". Use /skills list.]`);
		return;
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	if (enable) disabled.delete(name);
	else disabled.add(name);
	const next = [...disabled];
	updateSettings({ disabledSkills: next.length > 0 ? next : undefined });
	await reloadSkillsAfterChange(deps);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Skill ${name} ${enable ? "enabled" : "disabled"}]`,
	});
}

function formatSkillsList(deps: CommandDeps): string {
	const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
	if (discovered.length === 0) {
		return "No skills found. See --skill <path>, .cast/skills/, .agents/skills/, or `npx skills add`";
	}
	const disabled = new Set(loadSettings().disabledSkills ?? []);
	const lines = [...discovered]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => {
			const meta = formatSkillPickLabel(s, disabled.has(s.name));
			const state = disabled.has(s.name) ? "off" : "on ";
			return `${state} ${meta.label} — ${s.description}`;
		});
	return `Skills\n${lines.join("\n")}`;
}

async function handleSkillsCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/skills" ? "" : input.slice("/skills ".length).trim();
	if (args === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: SKILLS_HELP });
		return;
	}
	if (!args) {
		const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
		if (discovered.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No skills found. See --skill <path>, .cast/skills/, .agents/skills/, or `npx skills add`",
			});
			return;
		}
		const settings = loadSettings();
		const disabledNames = settings.disabledSkills ?? [];
		const enabledNames = await selectSkills(deps.pickers, discovered, disabledNames);
		if (enabledNames === null) {
			showNotice("[Cancelled]");
			return;
		}
		const enabledSet = new Set(enabledNames);
		const toggleable = discovered;
		const newDisabled = toggleable.map((s) => s.name).filter((n) => !enabledSet.has(n));
		const oldDisabledSet = new Set(disabledNames);
		const newDisabledSet = new Set(newDisabled);
		const toEnable = toggleable.map((s) => s.name).filter((n) => oldDisabledSet.has(n) && !newDisabledSet.has(n));
		const toDisable = toggleable.map((s) => s.name).filter((n) => !oldDisabledSet.has(n) && newDisabledSet.has(n));
		if (toEnable.length === 0 && toDisable.length === 0) return;
		updateSettings({ disabledSkills: newDisabled.length > 0 ? newDisabled : undefined });
		await reloadSkillsAfterChange(deps);
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `[Skills: enabled ${toEnable.length}, disabled ${toDisable.length}]`,
		});
		return;
	}

	const [verb, ...rest] = args.split(WHITESPACE_SPLIT_RE);
	const name = rest.join(" ").trim();
	if (verb === "list") {
		deps.agent.addDisplayMessage({ role: "warning", content: formatSkillsList(deps) });
		return;
	}
	if (verb === "enable" || verb === "disable") {
		if (!name) {
			showNotice(`[Usage: /skills ${verb} <name>]`);
			return;
		}
		await setSkillEnabled(deps, name, verb === "enable");
		return;
	}
	if (verb === "uninstall") {
		if (!name) {
			await uninstallSkillInteractive(deps);
			return;
		}
		const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
		const skill = discovered.find((s) => s.name === name);
		if (!skill) {
			showNotice(`[No skill named "${name}". Use /skills list.]`);
			return;
		}
		if (!isUninstallableSkill(skill)) {
			showNotice(
				`[Cannot uninstall ${skill.source} skill "${name}". Builtin and --skill paths are not removable here.]`,
			);
			return;
		}
		if (
			!(await confirmUninstall(
				deps,
				`Uninstall skill "${skill.name}" (${skill.source})?`,
				`Yes, uninstall "${skill.name}"`,
			))
		) {
			return;
		}
		await applySkillUninstall(deps, skill);
		return;
	}
	showNotice(`[Unknown /skills ${verb}. See /skills help]`);
}

async function reloadMcpAfterChange(deps: CommandDeps, disabledServers: string[]): Promise<void> {
	await closeMcpConnections(deps.mcpResult.connections);
	const newResult = await resolveMcpForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted, disabledServers);
	deps.setMcpResult(newResult);
	rebuildSystemPrompt(deps, deps.cwd);
	// Re-connecting MCP can leave Ink's stdin control unref'd (pauseInput), so
	// the stream stalls and keystrokes echo below the composer. Run a no-op
	// suspension to re-run Ink's resumeInput (like the /reload path — no clear,
	// which would make the screen visibly jump). Cancel any in-flight \x1b[6n
	// and give it a beat to land first: its reply echoes as visible ^[[6;1R
	// garbage once the suspension drops raw mode.
	cancelActiveDecxprQuery();
	await new Promise((resolve) => setTimeout(resolve, 30));
	await suspendAndRun(async () => {});
}

async function applyMcpUninstall(deps: CommandDeps, name: string): Promise<void> {
	const removed = removeMcpServerFromDisk(name, deps.cwd, deps.projectTrusted);
	if (!removed) {
		deps.showNotice(`[No uninstallable MCP server named "${name}". Use /mcp list.]`);
		return;
	}
	const disabled = (loadSettings().disabledMcpServers ?? []).filter((n) => n !== name);
	updateSettings({ disabledMcpServers: disabled.length > 0 ? disabled : undefined });
	await reloadMcpAfterChange(deps, disabled);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[Uninstalled MCP ${name} (${removed.origin})]`,
	});
}

async function uninstallMcpInteractive(deps: CommandDeps): Promise<void> {
	const removable = listUninstallableMcpServers(deps.cwd, deps.projectTrusted);
	if (removable.length === 0) {
		deps.agent.addDisplayMessage({
			role: "warning",
			content:
				"No uninstallable MCP servers in ~/.cast/mcp.json or .cast/mcp.json. CLI --mcp paths are not removable here.",
		});
		return;
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	const toolCounts: Record<string, number> = {};
	for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
	const blurbs = mcpServerToolBlurbs(deps.mcpResult);
	const picked = await deps.pickers.pickOption(
		[...removable]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => {
				const count = toolCounts[s.name];
				const status = disabled.has(s.name) ? "disabled" : count !== undefined ? `${count} tools` : "disconnected";
				return {
					value: s.name,
					label: `${s.name} (${s.origin}, ${status})`,
					description: blurbs[s.name] || (status === "disconnected" ? "Not connected" : undefined),
				};
			}),
		{ title: "Uninstall which MCP server?" },
	);
	if (!picked) {
		deps.showNotice("[Cancelled]");
		return;
	}
	if (!(await confirmUninstall(deps, `Uninstall MCP server "${picked}"?`, `Yes, uninstall "${picked}"`))) return;
	await applyMcpUninstall(deps, picked);
}

async function setMcpServerEnabled(deps: CommandDeps, name: string, enable: boolean): Promise<void> {
	const allNames = deps.mcpResult.allServerNames;
	if (!allNames.includes(name)) {
		deps.showNotice(`[No MCP server named "${name}". Use /mcp list.]`);
		return;
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	if (enable) disabled.delete(name);
	else disabled.add(name);
	const next = [...disabled];
	updateSettings({ disabledMcpServers: next.length > 0 ? next : undefined });
	await reloadMcpAfterChange(deps, next);
	deps.agent.addDisplayMessage({
		role: "warning",
		content: `[MCP ${name} ${enable ? "enabled" : "disabled"}]`,
	});
}

function formatMcpList(deps: CommandDeps): string {
	const allNames = deps.mcpResult.allServerNames;
	if (allNames.length === 0) {
		return "No MCP servers configured. See --mcp <path>, .cast/mcp.json";
	}
	const disabled = new Set(loadSettings().disabledMcpServers ?? []);
	const toolCounts: Record<string, number> = {};
	for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
	const ownership = new Map(listUninstallableMcpServers(deps.cwd, deps.projectTrusted).map((s) => [s.name, s.origin]));
	const lines = [...allNames]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const count = toolCounts[name];
			const origin = ownership.get(name) ?? "cli";
			const status = disabled.has(name) ? "disabled" : count !== undefined ? `${count} tools` : "disconnected";
			return `${disabled.has(name) ? "off" : "on "} ${name} (${origin}, ${status})`;
		});
	return `MCP\n${lines.join("\n")}`;
}

const SKILLS_SH_HELP = `skills.sh — install skills from the universal Agent Skills index:

  /skills-sh search QUERY            Find skills by keyword
  /skills-sh list-available OWNER/REPO
  /skills-sh install OWNER/REPO --skill NAME
  /skills-sh install npx skills add OWNER/REPO --skill NAME   (a pasted line works)
  /skills-sh uninstall NAME

Installs go to the universal scope (~/.agents/skills), which cast discovers
without a reload and every other agent on this machine shares.`;

async function handleSkillsShCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/skills-sh" ? "" : input.slice("/skills-sh ".length).trim();
	const [sub, ...restParts] = args ? args.split(WHITESPACE_SPLIT_RE) : [""];
	const rest = restParts.join(" ");
	if (!sub || sub === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: SKILLS_SH_HELP });
		return;
	}
	try {
		if (sub === "install") {
			showNotice("[skills.sh: installing…]");
			const out = await skillsShInstall(rest);
			await reloadSkillsAfterChange(deps);
			deps.agent.addDisplayMessage({ role: "warning", content: out || "Installed." });
			return;
		}
		if (sub === "uninstall") {
			showNotice("[skills.sh: removing…]");
			const out = await skillsShUninstall(rest);
			await reloadSkillsAfterChange(deps);
			deps.agent.addDisplayMessage({ role: "warning", content: out || "Uninstalled." });
			return;
		}
		if (sub === "list-available") {
			showNotice("[skills.sh: listing…]");
			deps.agent.addDisplayMessage({ role: "warning", content: await skillsShListAvailable(rest) });
			return;
		}
		if (sub === "search") {
			showNotice("[skills.sh: searching…]");
			deps.agent.addDisplayMessage({ role: "warning", content: await skillsShSearch(rest) });
			return;
		}
		showNotice(`[Unknown /skills-sh ${sub}. See /skills-sh help]`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.agent.addDisplayMessage({ role: "warning", content: `[skills.sh] ${message}` });
	}
}

async function handleMcpCommand(input: string, deps: CommandDeps): Promise<void> {
	const { showNotice } = deps;
	deps.agent.addDisplayMessage({ role: "user", content: input });
	const args = input === "/mcp" ? "" : input.slice("/mcp ".length).trim();
	if (args === "help") {
		deps.agent.addDisplayMessage({ role: "warning", content: MCP_HELP });
		return;
	}
	if (!args) {
		const allNames = deps.mcpResult.allServerNames;
		if (allNames.length === 0) {
			deps.agent.addDisplayMessage({
				role: "warning",
				content: "No MCP servers configured. See --mcp <path>, .cast/mcp.json",
			});
			return;
		}
		const settings = loadSettings();
		const disabledNames = settings.disabledMcpServers ?? [];
		const toolCounts: Record<string, number> = {};
		for (const c of deps.mcpResult.connections) toolCounts[c.serverName] = c.toolCount;
		const enabledNames = await selectMcpServers(
			deps.pickers,
			allNames,
			disabledNames,
			toolCounts,
			mcpServerToolBlurbs(deps.mcpResult),
		);
		if (enabledNames === null) {
			showNotice("[Cancelled]");
			return;
		}
		const newDisabled = allNames.filter((n) => !enabledNames.includes(n));
		const oldDisabledSet = new Set(disabledNames);
		const newDisabledSet = new Set(newDisabled);
		const toEnable = allNames.filter((n) => oldDisabledSet.has(n) && !newDisabledSet.has(n));
		const toDisable = allNames.filter((n) => !oldDisabledSet.has(n) && newDisabledSet.has(n));
		if (toEnable.length === 0 && toDisable.length === 0) return;
		updateSettings({ disabledMcpServers: newDisabled.length > 0 ? newDisabled : undefined });
		await reloadMcpAfterChange(deps, newDisabled);
		deps.agent.addDisplayMessage({
			role: "warning",
			content: `[MCP: enabled ${toEnable.length}, disabled ${toDisable.length}]`,
		});
		return;
	}

	const [verb, ...rest] = args.split(WHITESPACE_SPLIT_RE);
	const name = rest.join(" ").trim();
	if (verb === "list") {
		deps.agent.addDisplayMessage({ role: "warning", content: formatMcpList(deps) });
		return;
	}
	if (verb === "enable" || verb === "disable") {
		if (!name) {
			showNotice(`[Usage: /mcp ${verb} <name>]`);
			return;
		}
		await setMcpServerEnabled(deps, name, verb === "enable");
		return;
	}
	if (verb === "uninstall") {
		if (!name) {
			await uninstallMcpInteractive(deps);
			return;
		}
		const removable = listUninstallableMcpServers(deps.cwd, deps.projectTrusted);
		if (!removable.some((s) => s.name === name)) {
			showNotice(`[No uninstallable MCP server named "${name}". Use /mcp list.]`);
			return;
		}
		if (!(await confirmUninstall(deps, `Uninstall MCP server "${name}"?`, `Yes, uninstall "${name}"`))) return;
		await applyMcpUninstall(deps, name);
		return;
	}
	showNotice(`[Unknown /mcp ${verb}. See /mcp help]`);
}

/**
 * What a command is handed. Named for what the bodies already used, so a route
 * reads the same as it did inside the old `handleInput` chain.
 */
interface CommandContext {
	/** Trimmed input, including the leading slash. */
	input: string;
	/** Raw input, untrimmed — what gets submitted verbatim. */
	text: string;
	images: PendingImage[] | undefined;
	deps: CommandDeps;
	agent: UseAgentSession;
	session: SessionState;
	config: AppConfig;
	running: boolean;
	onQuit: () => void;
	showNotice: (text: string, duration?: number) => void;
}

/**
 * One slash command, or a family of them.
 *
 * `handleInput` used to be a single 2,200-line chain of `if (input === "/x")`
 * blocks, which made three things implicit that matter: the order commands are
 * tried in, the fact that a mid-chain guard decided which of them survive a
 * running turn (everything below it was refused), and the composer's separate
 * list of commands it may submit during a run. All three are now stated per
 * route — order is this array's order, and `whileRunning` carries the rest.
 */
interface CommandRoute {
	/** Matched against the trimmed input, in array order; first hit wins. */
	match: (input: string) => boolean;
	run: (ctx: CommandContext) => void | Promise<void>;
	/**
	 * Whether the command survives a running turn. "submit" also lets the
	 * composer send it mid-turn (see `canSubmitDuringRun`); "handle" is accepted
	 * here but not offered there, which is what the memory run-control commands
	 * did before this existed.
	 */
	whileRunning?: "submit" | "handle";
}

const BUSY_NOTICE = "[Agent running — use /queue, /steer, or /abort]";

/** Exact match on the command word, ignoring any arguments after it. */
function isCommand(input: string, ...names: string[]): boolean {
	const word = input.split(WHITESPACE_SPLIT_RE)[0]!;
	return names.includes(word);
}

function restoreSessionState(session: SessionState, source: SessionState): void {
	Object.assign(session, {
		id: source.id,
		messages: source.messages,
		model: source.model,
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
		usage: source.usage,
		lastPromptTokens: source.lastPromptTokens,
		cwd: source.cwd,
		mode: source.mode,
		persona: source.persona,
		lastAnnouncedLocalDate: source.lastAnnouncedLocalDate,
		providerUrl: source.providerUrl,
		reasoning: source.reasoning,
		turnMeta: source.turnMeta,
		title: source.title,
		pinned: source.pinned,
		todos: source.todos,
		shareToken: source.shareToken,
	});
}

// `personaName` override exists because the persona-switch flow calls this
// right after setCurrentPersona — deps.currentPersona still reads the OLD
// persona for the rest of this call (see the render-snapshot note above).
async function startNewSession(ctx: CommandContext, personaName?: string): Promise<void> {
	const { deps, agent, session, config, showNotice } = ctx;
	if (session.messages.length > 0) saveSession(session);
	const fresh = createSession(session.model, deps.cwd);
	Object.assign(session, fresh, {
		persona: personaName ?? deps.currentPersona.name,
		mode: undefined,
		lastPromptTokens: undefined,
		providerUrl: config.baseURL,
		reasoning: undefined,
		turnMeta: undefined,
		title: undefined,
		pinned: undefined,
		todos: undefined,
		shareToken: undefined,
	});
	saveSession(session);
	agent.clearContext();
	// A fresh session starts in build mode — plan mode is a per-task state,
	// not a sticky preference.
	deps.setPlanMode(false);
	// Fresh session should look like a fresh launch: banner at the top and
	// an empty transcript. The banner lives outside Ink's tree, so a plain
	// clearContext without a repaint leaves the old scrollback with no banner.
	await deps.onRepaintHistory?.();
	showNotice(`[New session: ${session.id}]`);
}

// Persona is session-level state: switching mid-thread leaves the previous
// persona's reasoning and tone in the context, bleeding into the new role.
// After a switch in a non-empty thread, offer a clean start (the /new flow)
// — Esc/cancel keeps the current thread, matching "show, don't force".
// Stamp the thread with the persona now driving it — or, when the thread
// already has history under another persona, ask first. Ordering matters:
// choosing "New session" must leave the OLD thread stamped with the persona
// that actually drove it (stamping before asking rewrote the old thread's
// persona and broke restore-on-resume for it).
async function applyPersonaToThread(ctx: CommandContext, persona: Persona, changed: boolean): Promise<void> {
	const { deps, session } = ctx;
	if (!changed || session.messages.length === 0) {
		session.persona = persona.name;
		saveSession(session);
		return;
	}
	const choice = await deps.pickers.pickOption(
		[
			{
				value: "new" as const,
				label: "New session — clean context for the new persona (recommended)",
			},
			{
				value: "keep" as const,
				label: "Continue here — keep the current conversation context",
			},
		],
		{ title: `Start a new session for ${persona.label}?` },
	);
	if (choice === "new") {
		await startNewSession(ctx, persona.name);
	} else {
		session.persona = persona.name;
		saveSession(session);
	}
}

// --- /provider helper: activate a provider + pick model + reasoning ---
async function activateProvider(ctx: CommandContext, p: Provider): Promise<void> {
	const { deps, agent, session, config, showNotice } = ctx;
	const probe = await probeProvider({ ...config, baseURL: p.url, apiKey: p.apiKey });
	if (probe !== "ok" && probe !== "unknown") {
		showNotice(`[Cannot reach provider "${p.name}": ${probe}]`);
		return;
	}
	showNotice(`[Provider: ${p.name}. Select a model and reasoning mode.]`);
	const candidate = {
		...config,
		baseURL: p.url,
		apiKey: p.apiKey,
		reasoningFormat: resolveReasoningFormat(p.url, p.reasoningFormat),
	};
	const selection = await selectModelWithReasoning(candidate, deps.pickers);
	if (!selection) {
		showNotice("[Cancelled — provider, model, and reasoning unchanged]");
		return;
	}
	config.baseURL = p.url;
	config.apiKey = p.apiKey;
	config.reasoningFormat = candidate.reasoningFormat;
	session.providerUrl = p.url;
	session.model = selection.model;
	deps.setReasoningMeta(selection.reasoningMeta);
	if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
	config.reasoningLevel = selection.reasoningLevel;
	config.reasoningParams = selection.reasoningParams;
	updateSettings({
		providerUrl: p.url,
		apiKey: p.apiKey,
		modelProvider: p.name,
		model: session.model,
		reasoningLevel: config.reasoningLevel,
	});
	updateSessionIdentity(session);
	agent.refreshMeta();
	showNotice(`[Provider: ${p.name}. Model: ${session.model}. Reasoning: ${config.reasoningLevel}]`);
}

// --- /provider helper: add wizard (mirrors /ssh add shape) ---
async function addProviderWizard(ctx: CommandContext, existing: Provider[]): Promise<void> {
	const { deps, agent, session, config, showNotice } = ctx;
	const name = await deps.pickers.promptText("Provider name (e.g. openrouter, local)");
	if (!name) {
		showNotice("[Cancelled]");
		return;
	}
	if (existing.some((p) => p.name === name)) {
		showNotice(`[Provider "${name}" already exists. Use a different name.]`);
		return;
	}
	const url = await deps.pickers.promptText("Provider base URL", undefined, "https://api.openai.com/v1");
	if (!url) {
		showNotice("[Cancelled]");
		return;
	}
	const key = await deps.pickers.promptText("Provider API key", undefined, "sk-...");
	if (!key) {
		showNotice("[Cancelled]");
		return;
	}

	const probe = await probeProvider({ ...config, baseURL: url, apiKey: key });
	if (probe !== "ok" && probe !== "unknown") {
		showNotice(`[Verification failed: ${probe}. Provider not saved.]`);
		return;
	}

	// Just save the provider (reasoning protocol is auto-detected from the
	// URL and enriched per-model from models.dev). No forced activation or
	// model pick here — that's the Model tab / `/model` / `/provider <name>`
	// job, matching the web form. The only exception: no active endpoint at
	// all (first provider), which becomes the default so there's something
	// to talk to.
	const next = [...existing, { name, url, apiKey: key }];
	if (!config.baseURL) {
		config.baseURL = url;
		config.apiKey = key;
		config.reasoningFormat = resolveReasoningFormat(url);
		session.providerUrl = url;
		updateSettings({ providers: next, providerUrl: url, apiKey: key, modelProvider: name });
		updateSessionIdentity(session);
		agent.refreshMeta();
		showNotice(`[Provider "${name}" added and set active (default). Pick a model: /model or the Model tab.]`);
		return;
	}
	updateSettings({ providers: next });
	showNotice(`[Provider "${name}" added — pick it in the Model tab or /provider ${name} to use it]`);
}

// --- /provider helper: delete picker ---
async function deleteProviderWizard(ctx: CommandContext, providers: Provider[]): Promise<void> {
	const { deps, session, config, showNotice } = ctx;
	if (providers.length === 0) {
		showNotice("[No providers to delete]");
		return;
	}
	const picked = await deps.pickers.pickOption(
		providers.map((p) => ({ value: p.name, label: `${p.name}  ${p.url}` })),
		{ title: "Delete which provider?" },
	);
	if (!picked) {
		showNotice("[Cancelled]");
		return;
	}
	const confirm = await deps.pickers.pickOption(
		[
			{ value: true, label: `Yes, remove "${picked}"` },
			{ value: false, label: "Cancel" },
		],
		{ title: `Remove provider "${picked}"?` },
	);
	if (confirm !== true) {
		showNotice("[Cancelled]");
		return;
	}

	// Warn if any model slot references this provider.
	const settings = loadSettings();
	const referencedBy = [
		settings.modelProvider === picked ? "main model" : null,
		settings.subagentModelProvider === picked ? "subagent model" : null,
		settings.planModelProvider === picked ? "plan model" : null,
	].filter(Boolean);
	if (referencedBy.length > 0) {
		showNotice(
			`[Warning: "${picked}" is used by ${referencedBy.join(", ")} — those slots will fall back to active provider]`,
		);
		const slotUpdate: Record<string, string | undefined> = {};
		if (settings.modelProvider === picked) slotUpdate.modelProvider = undefined;
		if (settings.subagentModelProvider === picked) slotUpdate.subagentModelProvider = undefined;
		if (settings.planModelProvider === picked) slotUpdate.planModelProvider = undefined;
		updateSettings(slotUpdate);
	}

	const updated = providers.filter((p) => p.name !== picked);
	const wasActive = providers.find((p) => p.name === picked);
	const isActive = wasActive && wasActive.url === config.baseURL && wasActive.apiKey === config.apiKey;

	if (isActive && updated.length > 0) {
		// Atomic: drop removed, switch active to the first remaining.
		const fallback = updated[0]!;
		updateSettings({
			providers: updated,
			providerUrl: fallback.url,
			apiKey: fallback.apiKey,
			modelProvider: fallback.name,
		});
		config.baseURL = fallback.url;
		config.apiKey = fallback.apiKey;
		session.providerUrl = fallback.url;
		showNotice(`[Provider "${picked}" removed. Switched to "${fallback.name}".]`);
	} else if (isActive && updated.length === 0) {
		// Clear the legacy providerUrl/apiKey so migrateProviders doesn't
		// resurrect the deleted provider as a "default" entry next startup.
		// Empty strings (not undefined — spread drops undefined keys, which
		// breaks the migration guard on next loadSettings).
		updateSettings({ providers: updated, providerUrl: "", apiKey: "", modelProvider: undefined });
		config.baseURL = "";
		config.apiKey = "";
		session.providerUrl = undefined;
		showNotice(`[Provider "${picked}" removed. No providers left — use /provider add to add one.]`);
	} else {
		updateSettings({ providers: updated });
		showNotice(`[Provider "${picked}" removed]`);
	}
}

const COMMAND_ROUTES: CommandRoute[] = [
	{
		match: (input) => isCommand(input, "/quit", "/exit"),
		// Quitting mid-turn worked before this registry existed (the branch sat
		// above the busy guard) and must keep working — you do not have to abort
		// a turn to be allowed to leave. Not "submit": the composer never
		// offered it during a run, and that is a separate decision.
		whileRunning: "handle",
		run: ({ onQuit }) => onQuit(),
	},
	{
		match: (input) => isCommand(input, "/abort", "/stop"),
		whileRunning: "submit",
		run: ({ agent }) => agent.abort(),
	},
	{
		match: (input) => isCommand(input, "/steer", "/s"),
		whileRunning: "submit",
		run: async ({ input, images, agent, running, showNotice }) => {
			const cmd = input.startsWith("/steer") ? "/steer" : "/s";
			const msg = input.slice(cmd.length).trim();
			if (!msg) {
				showNotice("[Usage: /steer <message> — injects it into the running turn]");
				return;
			}
			// Nothing running to steer — send it as a normal message instead.
			if (!running) {
				await agent.submit(msg, images);
				return;
			}
			// No transient showNotice on success — agent.pendingSteers now renders
			// above the composer for as long as the message is actually queued (see
			// App.tsx), not on a fixed timer that could clear it long before a
			// tool-heavy turn gets around to draining the queue.
			agent.steer(msg);
		},
	},
	{
		match: (input) => isCommand(input, "/reasoning-display", "/rd"),
		whileRunning: "submit",
		run: ({ agent, showNotice }) => {
			// toggleReasoning returns the post-toggle value (see useAgentSession)
			// so we can render an accurate notice without firing another React
			// read after setState. The next render fixes the underlying state
			// to the same value.
			const next = agent.toggleReasoning();
			showNotice(`[Reasoning display: ${next ? "on" : "off"}]`);
		},
	},
	{
		match: (input) => isCommand(input, "/queue-reset", "/qr"),
		whileRunning: "submit",
		run: ({ agent, showNotice }) => {
			agent.resetQueue();
			showNotice("[Queue cleared]");
		},
	},
	{
		match: (input) => isCommand(input, "/queue", "/q"),
		whileRunning: "submit",
		run: async ({ input, images, agent, running, showNotice }) => {
			const cmd = input.startsWith("/queue") ? "/queue" : "/q";
			const msg = input.slice(cmd.length).trim();
			if (!msg) {
				showNotice("[Usage: /queue <message> — runs after the current turn]");
				return;
			}
			// Nothing to queue behind when idle — just run it now as a normal turn,
			// which is what the user means by "do this next".
			if (!running) {
				await agent.submit(msg, images);
				return;
			}
			agent.followUp(msg);
		},
	},
	{
		match: (input) => input === "/dream" || input === "/distill",
		run: async ({ input, deps, agent, session, config, showNotice }) => {
			const memorySettings = loadSettings();
			if (memorySettings.memoryEnabled === false) {
				showNotice("[Project memory is disabled — use /memory on first]");
				return;
			}
			if (!isMemoryWriteEnabled(memorySettings)) {
				showNotice("[Project memory writing is disabled — use /memory write on first]");
				return;
			}
			showNotice(`[${input === "/dream" ? "Consolidating project memory" : "Distilling reusable workflows"}…]`);
			try {
				if (agent.daemonMode) {
					const result = (await agent.runCommand(input)) as
						| { removed?: number; stored?: number; artifacts?: unknown[] }
						| undefined;
					showNotice(
						input === "/dream"
							? `[Memory consolidated: ${result?.stored ?? 0} notes stored, ${result?.removed ?? 0} removed]`
							: `[Workflows distilled: ${result?.artifacts?.length ?? 0} artifact${result?.artifacts?.length === 1 ? "" : "s"}]`,
					);
					return;
				}
				if (input === "/dream") {
					const result = await dreamProjectMemory({
						cwd: deps.cwd,
						sessionId: session.id,
						model: session.model,
						config,
						messages: session.messages,
						runAgent: runMemoryMaintenanceAgent,
					});
					showNotice(`[Memory consolidated: ${result.stored} notes stored, ${result.removed} removed]`);
				} else {
					const result = await distillProjectMemory({
						cwd: deps.cwd,
						sessionId: session.id,
						model: session.model,
						config,
						messages: session.messages,
						runAgent: runMemoryMaintenanceAgent,
					});
					showNotice(
						`[Workflows distilled: ${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"}]`,
					);
				}
			} catch (error) {
				showNotice(`[Memory maintenance failed: ${error instanceof Error ? error.message : String(error)}]`);
			}
			return;
		},
	},
	{
		match: (input) => input === "/older",
		run: async ({ deps, agent, showNotice }) => {
			if (agent.loadOlder()) {
				// Prepending shifts every <Static> index — force the full replay so
				// the freshly-loaded page renders above the existing transcript
				// instead of duplicating the shifted tail (see useAgentSession.loadOlder).
				await deps.onRepaintHistory?.();
				showNotice("[Loaded older history — scroll up to read it]");
			} else {
				showNotice("[No older history — this is the start of the session]");
			}
			return;
		},
	},
	{
		match: (input) => input === "/continue",
		run: async ({ deps, agent, session, config, showNotice }) => {
			// Find the most recent session that isn't the current one — equivalent
			// to `cast -c` but from within a running session.
			const summaries = listSessionSummaries().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			const target = summaries.find((s) => s.id !== session.id);
			if (!target) {
				showNotice("[No other session to continue — this is the only one]");
				return;
			}
			const chosen = loadSession(target.id);
			if (!chosen) {
				showNotice(`[Session ${target.id} is no longer readable]`);
				return;
			}
			if (chosen.id === session.id) {
				showNotice("[Already in that session.]");
				return;
			}
			if (session.messages.length > 0) saveSession(session);
			const fallbackModel = session.model;
			const providerMatches = chosen.providerUrl === config.baseURL;
			const restoredModel = providerMatches ? chosen.model : fallbackModel;
			restoreSessionState(session, { ...chosen, model: restoredModel, providerUrl: config.baseURL });
			if (!providerMatches && chosen.model !== fallbackModel) {
				showNotice(`[Session model "${chosen.model}" belongs to another provider — keeping "${fallbackModel}".]`);
			}
			deps.setPlanMode(chosen.mode === "plan");
			let personaOpts = deps.personaOptions;
			let contextFilesSuffix: string | undefined;
			let rulesSuffix: string | undefined;
			let rulesLazySuffix: string | undefined;
			let skillsPromptSuffix: string | undefined;
			if (chosen.cwd && chosen.cwd !== deps.cwd) {
				deps.setCwd(chosen.cwd);
				const trusted = await resolveProjectTrustForCwd(deps.projectDeps, chosen.cwd);
				deps.setProjectTrusted(trusted);
				const resolved = await resolveSkillsForCwd(deps.projectDeps, chosen.cwd, trusted);
				deps.setSkills(resolved.skills);
				skillsPromptSuffix = resolved.skillsPromptSuffix;
				deps.setSkillsPromptSuffix(skillsPromptSuffix);
				contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(chosen.cwd, trusted));
				deps.setContextFilesSuffix(contextFilesSuffix);
				const resolvedRules = resolveRulesForCwd(chosen.cwd, trusted);
				rulesSuffix = resolvedRules.alwaysApplySuffix;
				rulesLazySuffix = resolvedRules.lazySuffix;
				deps.setRulesSuffix(rulesSuffix);
				deps.setRulesLazySuffix(rulesLazySuffix);
				deps.setDirectoryRules(resolvedRules.directoryRules);
				deps.setActiveAutoRules([]);
				deps.setSshHosts(resolveSshHosts(chosen.cwd, trusted));
				const newPersonaOpts = personaOptionsForCwd(chosen.cwd, trusted);
				deps.setPersonaOptions(newPersonaOpts);
				personaOpts = newPersonaOpts;
				await closeMcpConnections(deps.mcpResult.connections);
				deps.setMcpResult(
					await resolveMcpForCwd(deps.projectDeps, chosen.cwd, trusted, loadSettings().disabledMcpServers ?? []),
				);
			}
			let restoredPersona: Persona | undefined;
			if (chosen.persona && chosen.persona !== deps.currentPersona.name) {
				const sessionPersona = findPersona(chosen.persona, personaOpts);
				if (sessionPersona) {
					deps.setCurrentPersona(sessionPersona);
					restoredPersona = sessionPersona;
				} else {
					showNotice(
						`Session's persona "${chosen.persona}" no longer exists — keeping ${deps.currentPersona.label}.`,
					);
					session.persona = deps.currentPersona.name;
				}
			}
			rebuildSystemPrompt(deps, chosen.cwd || deps.cwd, {
				contextFilesSuffix,
				rulesSuffix,
				rulesLazySuffix,
				skillsPromptSuffix,
				...(restoredPersona ? { persona: restoredPersona } : {}),
			});
			agent.refresh();
			const personaNote = restoredPersona ? ` · persona: ${restoredPersona.label}` : "";
			showNotice(`[Continued session: ${session.id} (${session.messages.length} messages)${personaNote}]`);
			return;
		},
	},
	{
		match: (input) => input === "/fork",
		run: async ({ deps, agent, session, showNotice }) => {
			let forked: SessionState | undefined;
			try {
				forked = await agent.forkSession();
			} catch (err) {
				showNotice(`[Could not fork this session: ${err instanceof Error ? err.message : String(err)}]`);
				return;
			}
			if (!forked) {
				showNotice("[Could not fork this session]");
				return;
			}
			restoreSessionState(session, forked);
			agent.refresh();
			deps.setPlanMode(forked.mode === "plan");
			showNotice(`[Forked session: ${forked.id}]`);
			return;
		},
	},
	{
		match: (input) => input === "/copy",
		run: ({ session, showNotice }) => {
			for (let i = session.messages.length - 1; i >= 0; i--) {
				const msg = session.messages[i]!;
				if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
					const text = msg.content;
					try {
						const platform = process.platform;
						if (platform === "darwin") execSync("pbcopy", { input: text });
						else if (platform === "linux") execSync("xclip -selection clipboard", { input: text });
						else if (platform === "win32") execSync("clip", { input: Buffer.from(text, "utf-16le") });
						else {
							showNotice("[Clipboard not supported on this platform]");
							return;
						}
						showNotice(`[Copied ${text.length} chars to clipboard]`);
					} catch (err) {
						showNotice(`[Copy failed: ${err instanceof Error ? err.message : String(err)}]`);
					}
					return;
				}
			}
			showNotice("[No assistant response to copy]");
			return;
		},
	},
	{
		match: (input) => input === "/plan",
		run: ({ deps, showNotice }) => {
			// A run captures its tool set and system prompt at start; flipping the
			// mode under it would leave the prompt claiming one thing while the
			// executor gate enforces another. Modes only change between runs.
			if (deps.running) {
				showNotice("[Agent running — finish the run or /abort before switching modes]");
				return;
			}
			if (deps.planMode) {
				showNotice("[Already in plan mode]");
				return;
			}
			deps.setPlanMode(true);
			// MCP tools are a documented exception: plan mode hard-gates only the
			// built-in tools, so connected MCP servers keep their full capability.
			// The model is told to treat them as read-only, but that's prompt-level
			// — the user should know the guarantee is weaker there.
			const mcpCount = deps.mcpResult.toolDefinitions.length;
			showNotice(
				mcpCount > 0
					? `[Plan mode: ON — exploring and planning only · ${mcpCount} MCP tool${mcpCount === 1 ? "" : "s"} stay fully enabled (not gated by plan mode)]`
					: "[Plan mode: ON — exploring and planning only]",
			);
			return;
		},
	},
	{
		match: (input) => input === "/build",
		run: ({ deps, session, showNotice }) => {
			if (deps.running) {
				showNotice("[Agent running — finish the run or /abort before switching modes]");
				return;
			}
			if (!deps.planMode) {
				showNotice("[Not in plan mode]");
				return;
			}
			deps.setPlanMode(false);
			// With a plan on disk, /build is the approval gesture: the loop injects
			// the plan into the build-mode system prompt, so the user's next message
			// (however phrased) starts implementation guided by it.
			const hasPlan = readActivePlan(createPlanState(deps.cwd, session.id)).exists;
			showNotice(
				hasPlan
					? "[Plan mode: OFF — plan approved; your next message starts implementation]"
					: "[Plan mode: OFF — full toolset restored]",
			);
			return;
		},
	},
	{
		match: (input) => input === "/hooks" || input.startsWith("/hooks "),
		run: ({ input, deps, showNotice }) => {
			const args = input === "/hooks" ? "" : input.slice("/hooks ".length).trim();
			const [verb, ...rest] = args.split(WHITESPACE_SPLIT_RE).filter(Boolean);
			if (verb === "help") {
				deps.agent.addDisplayMessage({ role: "warning", content: HOOKS_HELP });
				return;
			}
			const { entries, diagnostics } = listHooksForCwdSettings(deps.cwd, deps.projectTrusted);
			if (!verb) {
				const diagLines = diagnostics.map((d) => `⚠ Failed to parse ${d.path}: ${d.message}`);
				if (entries.length === 0) {
					showNotice(
						[...diagLines, "[No hooks configured — see docs/hooks.md. Global: ~/.cast/hooks.json]"].join("\n"),
					);
					return;
				}
				const lines = entries.map(
					(e) =>
						`${e.enabled ? "●" : "○"} ${e.id}  ${e.event}${e.matcher ? ` (${e.matcher})` : ""}  [${e.source}]`,
				);
				showNotice(
					`[Hooks — /hooks enable|disable <id> to toggle:\n${[...diagLines, ...lines].join("\n")}]`,
					15000,
				);
				return;
			}
			if (verb === "enable" || verb === "disable") {
				const id = rest.join(" ").trim();
				if (!id) {
					showNotice(`[Usage: /hooks ${verb} <id> — run /hooks to see ids]`);
					return;
				}
				if (!entries.some((e) => e.id === id)) {
					showNotice(`[No hook with id "${id}". Run /hooks to list.]`);
					return;
				}
				const settings = loadSettings();
				const disabled = new Set(settings.disabledHooks ?? []);
				if (verb === "disable") disabled.add(id);
				else disabled.delete(id);
				updateSettings({ disabledHooks: [...disabled] });
				showNotice(`[Hook ${id} ${verb}d — takes effect on the next message]`);
				return;
			}
			showNotice(`[Unknown /hooks ${verb}. See /hooks help]`);
			return;
		},
	},
	{
		match: (input) => input === "/clear",
		run: async ({ deps, agent, showNotice }) => {
			agent.clearContext();
			await deps.onRepaintHistory?.();
			showNotice("[Context cleared]");
			return;
		},
	},
	{
		match: (input) => input === "/compact",
		run: async ({ deps, agent, session, config, showNotice }) => {
			// The same hooks the web /compact and the automatic threshold fire.
			// This path fired neither, so a PreCompact guard written to protect a
			// long transcript was honoured everywhere except here, and a
			// PostCompact bookkeeping hook never saw a manual TUI compaction.
			const compactHooks = resolveHooksForCwd(deps.cwd, deps.projectTrusted);
			const preCompact = await runHooksForEvent(compactHooks, {
				event: "PreCompact",
				cwd: deps.cwd,
				sessionId: session.id,
				payload: { trigger: "manual" },
			});
			if (preCompact.blocked) {
				showNotice(`[Compaction blocked by hook: ${preCompact.reason ?? "no reason given"}]`);
				return;
			}
			showNotice("[Compacting...]");
			try {
				const planState = createPlanState(deps.cwd, session.id);
				planState.enabled = deps.planMode;
				const result = await compactSessionMessages(
					session.messages,
					config,
					session.model,
					undefined,
					(attempt, reason) => showNotice(`[Retry ${attempt}: ${reason}]`),
					(usage) => addUsage(session, usage),
					deps.planMode ? PLAN_COMPACTION_PROMPT : undefined,
					reminderStateFromPlan(planState),
				);
				if (result.compacted) {
					recordCompaction(session, session.messages, result.messages);
					session.messages = result.messages;
					agent.refresh();
					showNotice(`[Compacted: ${result.messagesCompacted} msgs (~${result.tokensBefore} tokens)]`);
					void runHooksForEvent(compactHooks, {
						event: "PostCompact",
						cwd: deps.cwd,
						sessionId: session.id,
						payload: { trigger: "manual", messagesCompacted: result.messagesCompacted },
					});
				} else if (result.error) {
					showNotice(`[Compaction failed: ${result.error}]`);
				} else {
					showNotice("[Nothing to compact yet]");
				}
			} catch (err) {
				showNotice(`[Compaction error: ${err instanceof Error ? err.message : String(err)}]`);
			}
			return;
		},
	},
	{
		match: (input) => input === "/new",
		run: async (ctx) => {
			await startNewSession(ctx);
			return;
		},
	},
	{
		match: (input) => input === "/model",
		run: async ({ deps, agent, session, config, showNotice }) => {
			// Pass the current model so the picker opens highlighting it and marks it
			// "(current)" — that's the "show" half of /model, which otherwise just
			// dropped you straight into a selection list with no sign of where you were.
			const selection = await selectModelWithReasoning(config, deps.pickers, session.model);
			// selectModel returns null on cancel (Escape) rather than exiting the
			// process — it used to call process.exit(0) internally, which meant
			// cancelling this picker mid-session killed the whole running app
			// instead of just leaving the current model in place.
			if (!selection) {
				showNotice("[Cancelled — model and reasoning unchanged]");
				return;
			}
			session.model = selection.model;
			session.providerUrl = config.baseURL;
			deps.setReasoningMeta(selection.reasoningMeta);
			if (selection.contextWindow && selection.contextWindow > 0) config.contextWindow = selection.contextWindow;
			config.reasoningLevel = selection.reasoningLevel;
			config.reasoningParams = selection.reasoningParams;
			updateSettings({ model: session.model, reasoningLevel: config.reasoningLevel });
			updateSessionIdentity(session);
			agent.refreshMeta();
			showNotice(`[Model: ${session.model} (reasoning: ${config.reasoningLevel})]`);
			return;
		},
	},
	{
		match: (input) => input.startsWith("/model "),
		run: async ({ input, deps, agent, session, config, showNotice }) => {
			const newModel = input.slice(7).trim();
			const ok = await runOnboardingCheck(config, newModel, { log: deps.pickers.log });
			if (!ok) {
				showNotice(`[Model ${newModel} failed validation]`);
				return;
			}
			const found = getModelsCache().find((m) => m.id === newModel);
			const candidate = { ...config };
			const reasoningSelected = await selectReasoningLevel(
				candidate,
				newModel,
				deps.pickers,
				found?.reasoning,
				found?.reasoningSupported,
			);
			if (!reasoningSelected) {
				showNotice("[Cancelled — model and reasoning unchanged]");
				return;
			}
			session.model = newModel;
			session.providerUrl = config.baseURL;
			deps.setReasoningMeta(found?.reasoning);
			if (found?.contextWindow && found.contextWindow > 0) config.contextWindow = found.contextWindow;
			config.reasoningLevel = candidate.reasoningLevel;
			config.reasoningParams = candidate.reasoningParams;
			updateSettings({ model: newModel, reasoningLevel: config.reasoningLevel });
			updateSessionIdentity(session);
			agent.refreshMeta();
			showNotice(`[Model: ${newModel} (reasoning: ${config.reasoningLevel})]`);
			return;
		},
	},
	{
		match: (input) => input === "/plan-model",
		run: async ({ deps, agent, session, config, showNotice }) => {
			const providers = loadSettings().providers ?? [];
			const providerCreds = resolveProvider(providers, deps.planModelProvider, {
				baseURL: config.baseURL,
				apiKey: config.apiKey,
			});
			const selection = await selectModel(
				config,
				deps.pickers,
				deps.planModel ?? session.model,
				undefined,
				providerCreds,
			);
			if (!selection) {
				showNotice("[Cancelled — plan-mode model unchanged]");
				return;
			}
			deps.setPlanModel(selection.model);
			updateSettings({ planModel: selection.model });
			agent.refreshMeta();
			showNotice(`[Plan-mode model: ${selection.model}]`);
			return;
		},
	},
	{
		match: (input) => input.startsWith("/plan-model "),
		run: async ({ input, deps, agent, config, showNotice }) => {
			const newModel = input.slice("/plan-model ".length).trim();
			if (newModel === "off" || newModel === "reset") {
				deps.setPlanModel(undefined);
				if (newModel === "reset") deps.setPlanModelProvider(undefined);
				updateSettings({
					planModel: undefined,
					...(newModel === "reset" ? { planModelProvider: undefined } : {}),
				});
				showNotice("[Plan-mode model: off — plan mode uses the main model]");
				return;
			}
			const providers = loadSettings().providers ?? [];
			const providerCreds = resolveProvider(providers, deps.planModelProvider, {
				baseURL: config.baseURL,
				apiKey: config.apiKey,
			});
			const ok = await runOnboardingCheck({ ...config, ...providerCreds }, newModel, { log: deps.pickers.log });
			if (!ok) {
				showNotice(`[Model ${newModel} failed validation]`);
				return;
			}
			deps.setPlanModel(newModel);
			updateSettings({ planModel: newModel });
			agent.refreshMeta();
			showNotice(`[Plan-mode model: ${newModel}]`);
			return;
		},
	},
	{
		match: (input) => input === "/plan-model-provider" || input.startsWith("/plan-model-provider "),
		run: async ({ input, deps, config, showNotice }) => {
			const arg = input.slice("/plan-model-provider".length).trim();
			if (arg === "off" || arg === "reset") {
				deps.setPlanModelProvider(undefined);
				updateSettings({ planModelProvider: undefined });
				showNotice("[Plan-model provider: off — uses active provider]");
				return;
			}
			const providers = loadSettings().providers ?? [];
			if (!arg) {
				// Show picker
				const options: PickOption<string>[] = [
					{ value: "", label: `Active provider (${config.baseURL})` },
					...providers.map((p) => ({ value: p.name, label: `${p.name}  ${p.url}` })),
				];
				const picked = await deps.pickers.pickOption(options, { title: "Plan-model provider" });
				if (picked === null) {
					showNotice("[Cancelled]");
					return;
				}
				deps.setPlanModelProvider(picked || undefined);
				updateSettings({ planModelProvider: picked || undefined });
				showNotice(`[Plan-model provider: ${picked || "active"}]`);
				return;
			}
			// Direct name
			if (!providers.some((p) => p.name === arg)) {
				showNotice(`[Provider "${arg}" not found. Saved: ${providers.map((p) => p.name).join(", ") || "none"}]`);
				return;
			}
			deps.setPlanModelProvider(arg);
			updateSettings({ planModelProvider: arg });
			showNotice(`[Plan-model provider: ${arg}]`);
			return;
		},
	},
	{
		match: (input) => input === "/subagent-model",
		run: async ({ deps, agent, config, showNotice }) => {
			const providers = loadSettings().providers ?? [];
			const providerCreds = resolveProvider(providers, deps.subagentModelProvider, {
				baseURL: config.baseURL,
				apiKey: config.apiKey,
			});
			const current = deps.subagentModel;
			const selection = await selectModel(config, deps.pickers, current, undefined, providerCreds);
			if (!selection) {
				showNotice("[Cancelled — subagent model unchanged]");
				return;
			}
			deps.setSubagentModel(selection.model);
			updateSettings({ subagentModel: selection.model });
			agent.refreshMeta();
			showNotice(`[Subagent model: ${selection.model}]`);
			return;
		},
	},
	{
		match: (input) => input.startsWith("/subagent-model "),
		run: async ({ input, deps, agent, config, showNotice }) => {
			const newModel = input.slice(16).trim();
			if (newModel === "off" || newModel === "reset") {
				deps.setSubagentModel(undefined);
				if (newModel === "reset") deps.setSubagentModelProvider(undefined);
				updateSettings({
					subagentModel: undefined,
					...(newModel === "reset" ? { subagentModelProvider: undefined } : {}),
				});
				showNotice("[Subagent model: off — subagents use the main model]");
				return;
			}
			const providers = loadSettings().providers ?? [];
			const providerCreds = resolveProvider(providers, deps.subagentModelProvider, {
				baseURL: config.baseURL,
				apiKey: config.apiKey,
			});
			const ok = await runOnboardingCheck({ ...config, ...providerCreds }, newModel, { log: deps.pickers.log });
			if (!ok) {
				showNotice(`[Model ${newModel} failed validation]`);
				return;
			}
			deps.setSubagentModel(newModel);
			updateSettings({ subagentModel: newModel });
			agent.refreshMeta();
			showNotice(`[Subagent model: ${newModel}]`);
			return;
		},
	},
	{
		match: (input) => input === "/subagent-model-provider" || input.startsWith("/subagent-model-provider "),
		run: async ({ input, deps, config, showNotice }) => {
			const arg = input.slice("/subagent-model-provider".length).trim();
			if (arg === "off" || arg === "reset") {
				deps.setSubagentModelProvider(undefined);
				updateSettings({ subagentModelProvider: undefined });
				showNotice("[Subagent-model provider: off — uses active provider]");
				return;
			}
			const providers = loadSettings().providers ?? [];
			if (!arg) {
				// Show picker
				const options: PickOption<string>[] = [
					{ value: "", label: `Active provider (${config.baseURL})` },
					...providers.map((p) => ({ value: p.name, label: `${p.name}  ${p.url}` })),
				];
				const picked = await deps.pickers.pickOption(options, { title: "Subagent-model provider" });
				if (picked === null) {
					showNotice("[Cancelled]");
					return;
				}
				deps.setSubagentModelProvider(picked || undefined);
				updateSettings({ subagentModelProvider: picked || undefined });
				showNotice(`[Subagent-model provider: ${picked || "active"}]`);
				return;
			}
			// Direct name
			if (!providers.some((p) => p.name === arg)) {
				showNotice(`[Provider "${arg}" not found. Saved: ${providers.map((p) => p.name).join(", ") || "none"}]`);
				return;
			}
			deps.setSubagentModelProvider(arg);
			updateSettings({ subagentModelProvider: arg });
			showNotice(`[Subagent-model provider: ${arg}]`);
			return;
		},
	},
	{
		match: (input) => input === "/reasoning",
		run: async ({ deps, session, config, showNotice }) => {
			const cached = getModelsCache().find((m) => m.id === session.model);
			const meta = deps.reasoningMeta ?? cached?.reasoning;
			const changed = await selectReasoningLevel(
				config,
				session.model,
				deps.pickers,
				meta,
				cached?.reasoningSupported,
			);
			if (!changed) {
				showNotice("[Cancelled — reasoning unchanged]");
				return;
			}
			updateSettings({ reasoningLevel: config.reasoningLevel });
			showNotice(`[Reasoning: ${config.reasoningLevel}]`);
			return;
		},
	},
	{
		match: (input) => input === "/reasoning-format",
		run: async ({ deps, session, config, showNotice }) => {
			const selected = await selectReasoningFormat(deps.pickers, config.reasoningFormat);
			if (!selected) {
				showNotice("[Cancelled]");
				return;
			}
			const settings = loadSettings();
			const providers = settings.providers?.map((provider) =>
				provider.url === config.baseURL && provider.apiKey === config.apiKey
					? { ...provider, reasoningFormat: selected }
					: provider,
			);
			config.reasoningFormat = resolveReasoningFormat(config.baseURL, selected);
			const cached = getModelsCache().find((model) => model.id === session.model);
			const reasoningOptions = getReasoningOptionsForFormat(
				deps.reasoningMeta ?? cached?.reasoning ?? null,
				config.reasoningFormat,
				session.model,
				cached?.reasoningSupported,
			);
			if (
				reasoningOptions.length > 0 &&
				!reasoningOptions.some((option) => option.value === config.reasoningLevel)
			) {
				config.reasoningLevel = getDefaultReasoningLevel(
					deps.reasoningMeta ?? cached?.reasoning ?? null,
					config.reasoningFormat,
					session.model,
					cached?.reasoningSupported,
				);
			}
			config.reasoningParams = buildReasoningParams(config.reasoningLevel, config.reasoningFormat, session.model);
			updateSettings({ providers, reasoningLevel: config.reasoningLevel });
			showNotice(`[Reasoning protocol: ${selected}]`);
			return;
		},
	},
	{
		match: (input) => input === "/persona",
		run: async (ctx) => {
			const { deps, showNotice } = ctx;
			const selected = await selectPersona(deps.pickers, deps.personaOptions);
			if (!selected) {
				showNotice("[Cancelled — persona unchanged]");
				return;
			}
			const changed = selected.name !== deps.currentPersona.name;
			deps.setCurrentPersona(selected);
			updateSettings({ persona: selected.name });
			rebuildSystemPrompt(deps, deps.cwd, { persona: selected });
			showNotice(`[Persona: ${selected.label}]`);
			await applyPersonaToThread(ctx, selected, changed);
			return;
		},
	},
	{
		match: (input) => input.startsWith("/persona "),
		run: async (ctx) => {
			const { input, deps, showNotice } = ctx;
			const name = input.slice("/persona ".length).trim();
			const found = findPersona(name, deps.personaOptions);
			if (!found) {
				showNotice(`[Unknown persona "${name}". Use /persona to list available ones.]`);
				return;
			}
			const changed = found.name !== deps.currentPersona.name;
			deps.setCurrentPersona(found);
			updateSettings({ persona: found.name });
			rebuildSystemPrompt(deps, deps.cwd, { persona: found });
			showNotice(`[Persona: ${found.label}]`);
			await applyPersonaToThread(ctx, found, changed);
			return;
		},
	},
	{
		match: (input) => input === "/skills-sh" || input.startsWith("/skills-sh "),
		run: async ({ input, deps }) => {
			await handleSkillsShCommand(input, deps);
			return;
		},
	},
	{
		match: (input) => input === "/skills" || input.startsWith("/skills "),
		run: async ({ input, deps }) => {
			await handleSkillsCommand(input, deps);
			return;
		},
	},
	{
		match: (input) => input === "/mcp" || input.startsWith("/mcp "),
		run: async ({ input, deps }) => {
			await handleMcpCommand(input, deps);
			return;
		},
	},
	{
		match: (input) => input === "/reload",
		run: async ({ deps, showNotice }) => {
			showNotice("[Reloading...]");
			const trusted = await resolveProjectTrustForCwd(deps.projectDeps, deps.cwd);
			deps.setProjectTrusted(trusted);
			const { skills: newSkills, skillsPromptSuffix } = await resolveSkillsForCwd(
				deps.projectDeps,
				deps.cwd,
				trusted,
			);
			deps.setSkills(newSkills);
			deps.setSkillsPromptSuffix(skillsPromptSuffix);
			const contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(deps.cwd, trusted));
			deps.setContextFilesSuffix(contextFilesSuffix);
			const resolvedRules = resolveRulesForCwd(deps.cwd, trusted);
			const rulesSuffix = resolvedRules.alwaysApplySuffix;
			deps.setRulesSuffix(rulesSuffix);
			deps.setRulesLazySuffix(resolvedRules.lazySuffix);
			deps.setDirectoryRules(resolvedRules.directoryRules);
			deps.setActiveAutoRules([]); // Reset sticky rules on reload
			const newPersonaOpts = personaOptionsForCwd(deps.cwd, trusted);
			deps.setPersonaOptions(newPersonaOpts);
			const reloadedPersona = findPersona(deps.currentPersona.name, newPersonaOpts);
			if (reloadedPersona) {
				deps.setCurrentPersona(reloadedPersona);
			}
			rebuildSystemPrompt(deps, deps.cwd, {
				persona: reloadedPersona,
				contextFilesSuffix,
				rulesSuffix,
				rulesLazySuffix: resolvedRules.lazySuffix,
				skillsPromptSuffix,
			});
			await closeMcpConnections(deps.mcpResult.connections);
			deps.setMcpResult(
				await resolveMcpForCwd(deps.projectDeps, deps.cwd, trusted, loadSettings().disabledMcpServers ?? []),
			);
			// Re-resolving skills/MCP/personas can leave Ink's input control in a
			// bad state (stdin unref'd / readable listener dropped), so keystrokes
			// echo below the composer until a resize re-runs resumeInput. Run a
			// no-op suspension so Ink's endSuspend → resumeInput reinstates stdin.
			// Cancel an in-flight \x1b[6n first so its reply can't echo as garbage
			// once the suspension drops raw mode.
			cancelActiveDecxprQuery();
			await new Promise((resolve) => setTimeout(resolve, 30));
			await suspendAndRun(async () => {});
			showNotice(
				`[Reloaded: ${newSkills.length} skill(s), ${resolvedRules.directoryRules.length} rule(s), ${deps.mcpResult.connections.length} mcp server(s), personas]`,
			);
			return;
		},
	},
	{
		match: (input) => input === "/worktree" || input.startsWith("/worktree "),
		run: async ({ input, deps, agent, session, showNotice }) => {
			const rawArg = input === "/worktree" ? "" : input.slice("/worktree ".length).trim();
			if (!rawArg) {
				showNotice(
					"[Usage: /worktree <name> | /worktree list | /worktree remove <name> — e.g. /worktree fix-auth]",
				);
				return;
			}
			if (rawArg === "list") {
				const wts = listWorktrees(deps.cwd);
				if (wts.length === 0) {
					showNotice("[No active git worktrees found for this repository]");
				} else {
					const formatted = wts.map((w) => `${w.name} (${w.branch})`).join(", ");
					showNotice(`[Active worktrees: ${formatted}]`);
				}
				return;
			}
			if (rawArg.startsWith("remove ") || rawArg.startsWith("rm ") || rawArg === "remove" || rawArg === "rm") {
				const removeArg = rawArg.replace(WORKTREE_REMOVE_PREFIX_RE, "").trim();
				// `--force` discards uncommitted work and unmerged commits, so it has
				// to be asked for by name; a plain remove lets git's own guards stand.
				const force = WORKTREE_FORCE_FLAG_RE.test(removeArg);
				const targetName = removeArg.replace(WORKTREE_FORCE_STRIP_RE, "").trim();
				if (!targetName) {
					showNotice("[Usage: /worktree remove <name> [--force]]");
					return;
				}
				const res = await removeSessionWorktree(targetName, deps.cwd, {
					sessionId: session.id,
					projectTrusted: deps.projectTrusted,
					force,
				});
				showNotice(`[${res.message}]`);
				return;
			}
			const name = rawArg;
			if (deps.running) {
				showNotice("[Agent running — finish the run or /abort before switching worktrees]");
				return;
			}
			showNotice(`[Creating worktree "${name}"…]`);
			try {
				const wt = await createSessionWorktree(name, deps.cwd, {
					sessionId: session.id,
					projectTrusted: deps.projectTrusted,
				});
				// Persist the new cwd before anything that might re-read state.
				// run.ts uses session.cwd (not result.cwd) for subsequent tool
				// calls so the worktree path actually takes effect.
				session.cwd = wt.path;
				saveSession(session);
				deps.setCwd(wt.path);
				// Re-resolve everything that's keyed off cwd so the model sees the
				// worktree's skills, rules, MCP servers, and trust on the next turn.
				const trusted = await resolveProjectTrustForCwd(deps.projectDeps, wt.path);
				deps.setProjectTrusted(trusted);
				const { skills: newSkills, skillsPromptSuffix } = await resolveSkillsForCwd(
					deps.projectDeps,
					wt.path,
					trusted,
				);
				deps.setSkills(newSkills);
				deps.setSkillsPromptSuffix(skillsPromptSuffix);
				const contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(wt.path, trusted));
				deps.setContextFilesSuffix(contextFilesSuffix);
				const resolvedRules = resolveRulesForCwd(wt.path, trusted);
				deps.setRulesSuffix(resolvedRules.alwaysApplySuffix);
				deps.setRulesLazySuffix(resolvedRules.lazySuffix);
				deps.setDirectoryRules(resolvedRules.directoryRules);
				await closeMcpConnections(deps.mcpResult.connections);
				deps.setMcpResult(
					await resolveMcpForCwd(deps.projectDeps, wt.path, trusted, loadSettings().disabledMcpServers ?? []),
				);
				rebuildSystemPrompt(deps, wt.path, {
					contextFilesSuffix,
					rulesSuffix: resolvedRules.alwaysApplySuffix,
					rulesLazySuffix: resolvedRules.lazySuffix,
					skillsPromptSuffix,
				});
				agent.refresh();
				showNotice(
					`[Worktree: ${wt.path} (branch ${wt.branch}) — your next message runs in the isolated checkout]`,
				);
			} catch (err) {
				showNotice(`[Worktree failed: ${err instanceof Error ? err.message : String(err)}]`);
			}
			return;
		},
	},
	{
		match: (input) => input === "/undo",
		run: ({ deps, session, showNotice }) => {
			if (deps.running) {
				showNotice("[Agent running — finish the run or /abort before /undo]");
				return;
			}
			const checkpoints = session.checkpoints || [];
			if (checkpoints.length === 0) {
				showNotice("[No checkpoint available to undo]");
				return;
			}
			const lastCheckpoint = checkpoints.pop()!;
			const res = restoreCheckpoint(lastCheckpoint);
			if (!res.ok) {
				showNotice(`[Undo failed: ${res.message}]`);
				return;
			}
			// Drop the matching row so the persisted checkpoint list stays in sync.
			dropLastCheckpoint(session.id);

			const msgs = session.messages;
			let lastUserIdx = -1;
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]?.role === "user") {
					lastUserIdx = i;
					break;
				}
			}
			if (lastUserIdx !== -1) {
				session.messages = msgs.slice(0, lastUserIdx);
			}
			session.checkpoints = checkpoints;
			saveSession(session);
			deps.agent.refresh();
			showNotice(`[Undone: ${res.message}]`);
			return;
		},
	},
	{
		match: (input) => input.startsWith("/skill:"),
		run: async ({ input, deps, agent, session, showNotice }) => {
			const rest = input.slice("/skill:".length);
			const spaceIdx = rest.indexOf(" ");
			const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
			const skillArgs = spaceIdx === -1 ? undefined : rest.slice(spaceIdx + 1).trim();
			const skill = deps.skills.find((s) => s.name === skillName && s.userInvocable);
			if (!skill) {
				const discovered = discoverSkillsForCwd(deps.projectDeps, deps.cwd, deps.projectTrusted);
				if (discovered.some((s) => s.name === skillName)) {
					showNotice(`[Skill "${skillName}" is disabled. Re-enable it with /skills.]`);
				} else {
					showNotice(`[No skill named "${skillName}". Use /skills to toggle available skills.]`);
				}
				return;
			}
			fireUserPromptExpansion(deps, skill.name);
			await agent.submit(await renderSkillInvocation(skill, skillArgs, session.id, { projectDir: deps.cwd }));
			return;
		},
	},
	{
		match: (input) => input === "/provider" || input.startsWith("/provider "),
		run: async (ctx) => {
			const { input, deps, config, showNotice } = ctx;
			const sub = input.slice("/provider".length).trim();
			const settings = loadSettings();
			const providers = settings.providers ?? [];

			if (sub === "add") {
				await addProviderWizard(ctx, providers);
				return;
			}
			if (sub === "delete") {
				await deleteProviderWizard(ctx, providers);
				return;
			}
			if (sub) {
				const found = providers.find((p) => p.name === sub);
				if (!found) {
					showNotice(`[Unknown provider "${sub}". Use /provider to list.]`);
					return;
				}
				await activateProvider(ctx, found);
				return;
			}

			// /provider (no subcommand) — picker, or auto-add when empty.
			if (providers.length === 0) {
				showNotice("[No providers configured. Adding a new one.]");
				await addProviderWizard(ctx, providers);
				return;
			}
			type ProviderChoice = { provider: Provider } | { action: "add" } | { action: "delete" };
			const options: Array<{ value: ProviderChoice; label: string }> = providers.map((p) => ({
				value: { provider: p },
				label: `${p.name}  ${p.url}${p.url === config.baseURL ? "  (current)" : ""}`,
			}));
			options.push({ value: { action: "add" }, label: "Add a new provider..." });
			options.push({ value: { action: "delete" }, label: "Delete a provider..." });

			const picked = await deps.pickers.pickOption(options, { title: "Providers" });
			if (!picked) {
				showNotice("[Cancelled]");
				return;
			}
			if ("action" in picked) {
				if (picked.action === "add") await addProviderWizard(ctx, providers);
				else await deleteProviderWizard(ctx, providers);
				return;
			}
			await activateProvider(ctx, picked.provider);
			return;
		},
	},
	{
		match: (input) => input === "/permissions",
		run: async ({ deps }) => {
			const newMode = await selectPermissionMode(deps.pickers, deps.permissionMode);
			await applyPermissionMode(deps, newMode);
			return;
		},
	},
	{
		match: (input) => input === "/permissions default" || input === "/permissions bypass",
		run: async ({ input, deps }) => {
			const newMode = input.endsWith("bypass") ? "bypass" : "default";
			await applyPermissionMode(deps, newMode);
			return;
		},
	},
	{
		match: (input) => input === "/web",
		run: async ({ deps, showNotice }) => {
			const enabled = deps.webToolsEnabled;
			const picked = await deps.pickers.pickOption(
				[
					{ value: true, label: `Enable web tools (currently ${enabled ? "on" : "off"})` },
					{ value: false, label: `Disable web tools (currently ${enabled ? "on" : "off"})` },
				],
				{ title: "Web tools (web_search, web_fetch)" },
			);
			if (picked === null) {
				showNotice("[Cancelled — web tools unchanged]");
				return;
			}
			deps.setWebToolsEnabled(picked);
			updateSettings({ webTools: picked });
			showNotice(`[Web tools: ${picked ? "enabled" : "disabled"}]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_AUTO_TOGGLE_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryAutoToggleMatch = input.match(MEMORY_AUTO_TOGGLE_COMMAND_RE)!;
			const kind = memoryAutoToggleMatch[1];
			const enabled = memoryAutoToggleMatch[2] === "on";
			updateSettings(kind === "dream" ? { memoryDreamAuto: enabled } : { memoryDistillAuto: enabled });
			showNotice(`[Automatic ${kind}: ${enabled ? "enabled" : "disabled"}]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_CHECKPOINT_FORK_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryCheckpointForkMatch = input.match(MEMORY_CHECKPOINT_FORK_COMMAND_RE)!;
			updateSettings({ checkpointFork: memoryCheckpointForkMatch[1] === "on" });
			showNotice(`[Checkpoint prefix fork: ${memoryCheckpointForkMatch[1] === "on" ? "enabled" : "disabled"}]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_CHECKPOINT_THRESHOLDS_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const checkpointThresholdsMatch = input.match(MEMORY_CHECKPOINT_THRESHOLDS_COMMAND_RE)!;
			const raw = checkpointThresholdsMatch[1]!;
			if (raw.trim() === "default") {
				updateSettings({ checkpointThresholds: undefined });
				showNotice("[Checkpoint thresholds: window defaults]");
				return;
			}
			const values = raw
				.split(",")
				.map((part) => Number(part.trim()))
				.filter((value) => Number.isFinite(value));
			if (values.length === 0 || values.some((value) => value <= 0 || value > 100)) {
				showNotice("[Checkpoint thresholds must be percentages like 20,40,60,80 or 'default']");
				return;
			}
			updateSettings({ checkpointThresholds: values });
			showNotice(`[Checkpoint thresholds: ${values.join("%,")}%]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_CHECKPOINT_RESERVED_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const checkpointReservedMatch = input.match(MEMORY_CHECKPOINT_RESERVED_COMMAND_RE)!;
			const value = Number(checkpointReservedMatch[1]);
			if (!Number.isInteger(value) || value < 0) {
				showNotice("[Checkpoint reserved must be a non-negative token count]");
				return;
			}
			updateSettings({ checkpointReserved: value });
			showNotice(`[Checkpoint reserved: ${value} tokens]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_CHECKPOINT_CAPS_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const checkpointCapsMatch = input.match(MEMORY_CHECKPOINT_CAPS_COMMAND_RE)!;
			const raw = checkpointCapsMatch[1]!;
			if (raw.trim() === "default") {
				updateSettings({ checkpointPushCaps: undefined });
				showNotice("[Checkpoint section caps: defaults]");
				return;
			}
			const caps: Record<string, number> = {};
			let invalid = false;
			for (const pair of raw.split(",")) {
				const [key, valueText] = pair.split("=");
				const keyTrimmed = key?.trim() ?? "";
				const value = Number(valueText?.trim());
				if (
					!["checkpoint", "memory", "notes", "global", "tasks"].includes(keyTrimmed) ||
					!Number.isFinite(value) ||
					value <= 0
				) {
					invalid = true;
					break;
				}
				caps[keyTrimmed] = Math.floor(value);
			}
			if (invalid || Object.keys(caps).length === 0) {
				showNotice(
					"[Checkpoint caps must be like checkpoint=11000,memory=10000,notes=6000,global=6000,tasks=2000 or 'default']",
				);
				return;
			}
			updateSettings({ checkpointPushCaps: caps });
			showNotice("[Checkpoint section caps updated]");
			return;
		},
	},
	{
		match: (input) => MEMORY_AUTO_INTERVAL_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryAutoIntervalMatch = input.match(MEMORY_AUTO_INTERVAL_COMMAND_RE)!;
			const kind = memoryAutoIntervalMatch[1];
			const days = Number(memoryAutoIntervalMatch[2]);
			if (!Number.isInteger(days) || days < 0 || days > 3_650) {
				showNotice("[Automatic memory interval must be an integer from 0 to 3650 days]");
				return;
			}
			updateSettings(kind === "dream" ? { memoryDreamIntervalDays: days } : { memoryDistillIntervalDays: days });
			showNotice(`[Automatic ${kind} interval: ${days} day${days === 1 ? "" : "s"}]`);
			return;
		},
	},
	{
		match: (input) => input === "/memory runs",
		whileRunning: "handle",
		run: ({ session, showNotice }) => {
			const runs = listAutomaticMemoryRuns(session.id);
			showNotice(
				runs.length === 0
					? "[No automatic memory runs]"
					: runs.map((run) => `[${run.id} ${run.kind} ${run.status} session=${run.sessionId}]`).join("\n"),
			);
			return;
		},
	},
	{
		match: (input) => MEMORY_CANCEL_RUN_COMMAND_RE.test(input),
		whileRunning: "handle",
		run: ({ input, showNotice }) => {
			const memoryCancelRunMatch = input.match(MEMORY_CANCEL_RUN_COMMAND_RE)!;
			showNotice(
				cancelAutomaticMemoryRun(memoryCancelRunMatch[1]!)
					? `[Cancelled automatic memory run ${memoryCancelRunMatch[1]}]`
					: `[Automatic memory run not found or already finished: ${memoryCancelRunMatch[1]}]`,
			);
			return;
		},
	},
	{
		match: (input) => input === "/memory dream" || input === "/memory distill",
		run: async ({ input, deps, showNotice }) => {
			const kind = input.endsWith("dream") ? "dream" : "distill";
			const settings = loadSettings();
			const current = kind === "dream" ? settings.memoryDreamAuto === true : settings.memoryDistillAuto === true;
			const picked = await deps.pickers.pickOption(
				[
					{ value: true, label: `Enable automatic ${kind} (currently ${current ? "on" : "off"})` },
					{ value: false, label: `Disable automatic ${kind} (currently ${current ? "on" : "off"})` },
				],
				{ title: `Automatic ${kind}` },
			);
			if (picked === null) return;
			updateSettings(kind === "dream" ? { memoryDreamAuto: picked } : { memoryDistillAuto: picked });
			showNotice(`[Automatic ${kind}: ${picked ? "enabled" : "disabled"}]`);
			return;
		},
	},
	{
		match: (input) =>
			input === "/memory" ||
			input === "/memory on" ||
			input === "/memory off" ||
			input === "/memory write" ||
			input === "/memory write on" ||
			input === "/memory write off",
		run: async ({ input, deps, showNotice }) => {
			const settings = loadSettings();
			const writeMode = input === "/memory write" || input.startsWith("/memory write ");
			const current = writeMode ? settings.memoryWriteEnabled !== false : settings.memoryEnabled !== false;
			let next: boolean;
			if (input === "/memory on" || input === "/memory write on") next = true;
			else if (input === "/memory off" || input === "/memory write off") next = false;
			else {
				const picked = await deps.pickers.pickOption(
					[
						{
							value: true,
							label: `${writeMode ? "Enable background memory writing" : "Enable project memory"} (currently ${current ? "on" : "off"})`,
						},
						{
							value: false,
							label: `${writeMode ? "Disable background memory writing" : "Disable project memory"} (currently ${current ? "on" : "off"})`,
						},
					],
					{ title: writeMode ? "Background memory writing" : "Durable project memory" },
				);
				if (picked === null) {
					showNotice("[Cancelled — project memory unchanged]");
					return;
				}
				next = picked;
			}
			if (writeMode) updateSettings({ memoryWriteEnabled: next });
			else updateSettings({ memoryEnabled: next });
			showNotice(
				`[${writeMode ? "Background memory writing" : "Project memory"}: ${next ? "enabled" : "disabled"}]`,
			);
			return;
		},
	},
	{
		match: (input) => MEMORY_BUDGET_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryBudgetMatch = input.match(MEMORY_BUDGET_COMMAND_RE)!;
			const value = Number(memoryBudgetMatch[1]);
			if (!Number.isInteger(value) || value < 256 || value > 16_384) {
				showNotice("[Memory prompt budget must be an integer from 256 to 16384]");
				return;
			}
			updateSettings({ memoryPromptBudget: value });
			showNotice(`[Memory prompt budget: ${value} tokens]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_FLOOR_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryFloorMatch = input.match(MEMORY_FLOOR_COMMAND_RE)!;
			const value = Number(memoryFloorMatch[1]);
			updateSettings({ memorySearchScoreFloor: value });
			showNotice(`[Memory search score floor: ${value}]`);
			return;
		},
	},
	{
		match: (input) => MEMORY_RECONCILE_COMMAND_RE.test(input),
		run: ({ input, showNotice }) => {
			const memoryReconcileMatch = input.match(MEMORY_RECONCILE_COMMAND_RE)!;
			const enabled = memoryReconcileMatch[1] === "on";
			updateSettings({ memoryReconcileOnSearch: enabled });
			showNotice(`[Memory reconcile before search: ${enabled ? "enabled" : "disabled"}]`);
			return;
		},
	},
	{
		match: (input) => input === "/web-search-provider",
		run: async ({ deps, showNotice }) => {
			const settings = loadSettings();
			const current = settings.searchProvider ?? "ddg";
			const picked = await deps.pickers.pickOption(
				[
					{
						value: "ddg" as const,
						label: `DuckDuckGo — free, no key, ~4 searches per IP before rate-limited${current === "ddg" ? " (current)" : ""}`,
					},
					{
						value: "tavily" as const,
						label: `Tavily — API key required, 1000 free searches/month${current === "tavily" ? " (current)" : ""}`,
					},
					{
						value: "brave" as const,
						label: `Brave Search — API key required, general web index${current === "brave" ? " (current)" : ""}`,
					},
				],
				{ title: "Web search backend" },
			);
			if (picked === null) {
				showNotice("[Cancelled — search provider unchanged]");
				return;
			}
			if (picked === "ddg") {
				updateSettings({ searchProvider: "ddg" });
				showNotice("[Web search backend: DuckDuckGo]");
				return;
			}
			if (picked === "tavily") {
				const key = await deps.pickers.promptText(
					"Tavily API key (https://app.tavily.com)",
					settings.tavilyApiKey,
					"tvly-...",
				);
				if (!key) {
					showNotice("[Cancelled — search provider unchanged]");
					return;
				}
				updateSettings({ searchProvider: "tavily", tavilyApiKey: key });
				showNotice("[Web search backend: Tavily]");
				return;
			}
			const key = await deps.pickers.promptText(
				"Brave Search API key (https://api-dashboard.search.brave.com)",
				settings.braveApiKey,
				"BSA...",
			);
			if (!key) {
				showNotice("[Cancelled — search provider unchanged]");
				return;
			}
			updateSettings({ searchProvider: "brave", braveApiKey: key });
			showNotice("[Web search backend: Brave]");
			return;
		},
	},
	{
		match: (input) => input === "/web-fetch-provider",
		run: async ({ deps, showNotice }) => {
			const settings = loadSettings();
			const current = settings.webFetchProvider ?? "jina";
			const picked = await deps.pickers.pickOption(
				[
					{
						value: "jina" as const,
						label: `Jina Reader — free, no key, handles JS rendering/PDFs${current === "jina" ? " (current)" : ""}`,
					},
					{
						value: "local" as const,
						label: `Local — direct fetch, no third party sees the URL${current === "local" ? " (current)" : ""}`,
					},
				],
				{ title: "Web fetch backend" },
			);
			if (picked === null) {
				showNotice("[Cancelled — fetch provider unchanged]");
				return;
			}
			updateSettings({ webFetchProvider: picked });
			showNotice(`[Web fetch backend: ${picked === "jina" ? "Jina Reader" : "Local"}]`);
			return;
		},
	},
	{
		match: (input) => input === "/statusbar",
		run: async ({ deps, showNotice }) => {
			const allSegments = getStatusBarSegments();
			if (!deps.pickers.pickStatusBar) {
				showNotice("[Status bar picker not available in this mode]");
				return;
			}
			const picked = await deps.pickers.pickStatusBar(allSegments, deps.statusBar);
			if (picked === null) {
				showNotice("[Cancelled — status bar unchanged]");
				return;
			}
			// Overflow warning
			const visibleSegs = allSegments.filter((s) => picked.visible.includes(s.id));
			const totalWidth =
				visibleSegs.reduce((sum, s) => sum + (SEGMENT_MAX_WIDTH[s.id] ?? 15), 0) + (visibleSegs.length - 1) * 3;
			const cols = process.stdout.columns ?? 80;
			if (totalWidth > cols) {
				showNotice(`[Warning: status bar (~${totalWidth} cols) may overflow ${cols}-col terminal]`, 10000);
			}
			updateSettings({ statusBar: picked });
			deps.setStatusBar(picked);
			showNotice(`[Status bar: ${picked.visible.length} segment${picked.visible.length === 1 ? "" : "s"}]`);
			return;
		},
	},
	{
		match: (input) => input === "/ssh" || input.startsWith("/ssh "),
		run: async ({ input, deps, showNotice }) => {
			const sub = input.slice("/ssh".length).trim();
			if (sub === "add") {
				// --- Interactive wizard ---
				const name = await deps.pickers.promptText("SSH host name (e.g. my-server)");
				if (!name) {
					showNotice("[Cancelled]");
					return;
				}
				if (deps.sshHosts.some((h) => h.name === name)) {
					showNotice(`[Host "${name}" already exists. Use a different name.]`);
					return;
				}
				const host = await deps.pickers.promptText("Host address (IP or hostname)");
				if (!host) {
					showNotice("[Cancelled]");
					return;
				}
				const username = await deps.pickers.promptText("Username", undefined, "root");
				if (!username) {
					showNotice("[Cancelled]");
					return;
				}
				const portStr = await deps.pickers.promptText("Port", undefined, "22");
				if (!portStr) {
					showNotice("[Cancelled]");
					return;
				}
				const port = Number.parseInt(portStr, 10) || 22;

				// Auth method
				const authMethod = await deps.pickers.pickOption(
					[
						{ value: "key" as const, label: "Key-based (keyPath)" },
						{ value: "password" as const, label: "Password (requires sshpass)" },
					],
					{ title: "Authentication method" },
				);
				if (!authMethod) {
					showNotice("[Cancelled]");
					return;
				}

				let keyPath: string | undefined;
				let password: string | undefined;

				if (authMethod === "key") {
					const availableKeys = scanSshKeys();
					if (availableKeys.length > 0) {
						const keyOptions = [
							...availableKeys.map((k) => ({ value: k, label: k })),
							{ value: "__other__", label: "Other (enter path)" },
						];
						const picked = await deps.pickers.pickOption(keyOptions, {
							title: "SSH key",
							defaultIndex: 0,
						});
						if (!picked) {
							showNotice("[Cancelled]");
							return;
						}
						if (picked === "__other__") {
							const custom = await deps.pickers.promptText("Key path", undefined, "~/.ssh/id_ed25519");
							if (!custom) {
								showNotice("[Cancelled]");
								return;
							}
							keyPath = custom;
						} else {
							keyPath = picked;
						}
					} else {
						const custom = await deps.pickers.promptText("Key path", undefined, "~/.ssh/id_ed25519");
						if (!custom) {
							showNotice("[Cancelled]");
							return;
						}
						keyPath = custom;
					}
					// Validate key with retry loop
					while (true) {
						const err = keyPath
							? validateKeyPermissions(keyPath.startsWith("~/") ? keyPath.replace("~", homedir()) : keyPath)
							: undefined;
						if (!err) break;
						// biome-ignore lint/performance/noAwaitInLoops: SSH key retry requires user interaction
						const retry = await deps.pickers.promptText(err, keyPath, "~/.ssh/id_ed25519");
						if (!retry) {
							showNotice("[Cancelled]");
							return;
						}
						keyPath = retry;
					}
				} else {
					const pw = await deps.pickers.promptText("Password");
					if (!pw) {
						showNotice("[Cancelled]");
						return;
					}
					password = pw;
				}

				// Dangerous commands
				const dangerMode = await deps.pickers.pickOption(
					[
						{ value: "default" as const, label: "Default (block dangerous commands like sudo)" },
						{ value: "bypass" as const, label: "Bypass (allow all commands — for hosts where sudo is expected)" },
					],
					{ title: "Dangerous command policy" },
				);
				if (!dangerMode) {
					showNotice("[Cancelled]");
					return;
				}

				const newHost: SshHost = { name, host, username, port, dangerousCommands: dangerMode };
				if (keyPath) newHost.keyPath = keyPath;
				if (password) newHost.password = password;

				const updated = [...deps.sshHosts, newHost];
				saveSshConfig(updated);
				deps.setSshHosts(updated);
				showNotice(`[SSH host "${name}" added]`);
				return;
			}

			if (sub === "remove" || sub.startsWith("remove ")) {
				const targetName = sub.slice("remove".length).trim();
				if (deps.sshHosts.length === 0) {
					showNotice("[No SSH hosts to remove]");
					return;
				}
				let removeName = targetName;
				if (!removeName) {
					const picked = await deps.pickers.pickOption(
						deps.sshHosts.map((h) => ({
							value: h.name,
							label: `${h.name} (${h.username ? `${h.username}@` : ""}${h.host})`,
						})),
						{ title: "Remove which SSH host?" },
					);
					if (!picked) {
						showNotice("[Cancelled]");
						return;
					}
					removeName = picked;
				}
				const found = deps.sshHosts.find((h) => h.name === removeName);
				if (!found) {
					showNotice(`[Unknown host "${removeName}". Use /ssh to list hosts.]`);
					return;
				}
				const confirm = await deps.pickers.pickOption(
					[
						{ value: true, label: `Yes, remove "${removeName}"` },
						{ value: false, label: "Cancel" },
					],
					{ title: `Remove SSH host "${removeName}"?` },
				);
				if (confirm !== true) {
					showNotice("[Cancelled]");
					return;
				}
				const updated = deps.sshHosts.filter((h) => h.name !== removeName);
				saveSshConfig(updated);
				deps.setSshHosts(updated);
				showNotice(`[SSH host "${removeName}" removed]`);
				return;
			}

			// Anything else non-empty used to fall straight through to the "list
			// hosts" default below — a typo like "/ssh ad" (missing the second d)
			// silently listed hosts instead of erroring on the unrecognized
			// subcommand, same as bare /ssh.
			if (sub) {
				showNotice(`[Unknown /ssh subcommand "${sub}". Use /ssh add or /ssh remove.]`);
				return;
			}

			// /ssh (no subcommand) — list hosts
			deps.agent.addDisplayMessage({ role: "user", content: input });
			if (deps.sshHosts.length === 0) {
				deps.agent.addDisplayMessage({
					role: "warning",
					content: "No SSH hosts configured. Use /ssh add to add one, or edit ~/.cast/ssh.json",
				});
				return;
			}
			const lines = deps.sshHosts.map((h) => {
				const user = h.username ? `${h.username}@` : "";
				const auth = h.password ? "password" : "key";
				const danger = h.dangerousCommands === "bypass" ? " (no safety check)" : "";
				return `  ${h.name.padEnd(16)} ${user}${h.host}:${h.port || 22}  ${auth}${danger}`;
			});
			deps.agent.addDisplayMessage({ role: "warning", content: `SSH Hosts\n${lines.join("\n")}` });
			return;
		},
	},
	{
		match: (input) => input === "/theme" || input.startsWith("/theme "),
		run: async ({ input, deps, showNotice }) => {
			const arg = input.slice("/theme".length).trim();
			if (arg) {
				const found = ALL_THEMES.find((t) => t.id === arg);
				if (!found) {
					showNotice(`[Unknown theme "${arg}". Use /theme to list available.]`);
					return;
				}
				setActiveTheme(found.id);
				updateSettings({ theme: found.id });
				deps.onThemeChange?.();
				showNotice(`[Theme: ${found.label}]`);
				return;
			}
			const currentId = getActiveTheme().id;
			const picked = await deps.pickers.pickOption(
				ALL_THEMES.map((t) => ({
					value: t.id,
					label: `${t.label}${t.id === currentId ? " (current)" : ""}`,
					description: t.description,
				})),
				{ title: "Color themes", defaultIndex: ALL_THEMES.findIndex((t) => t.id === currentId) },
			);
			if (!picked) {
				showNotice("[Cancelled — theme unchanged]");
				return;
			}
			setActiveTheme(picked);
			updateSettings({ theme: picked });
			deps.onThemeChange?.();
			showNotice(`[Theme: ${ALL_THEMES.find((t) => t.id === picked)?.label ?? picked}]`);
			return;
		},
	},
	{
		match: (input) => input === "/current",
		run: ({ deps, agent, session, config }) => {
			const allSegs = getStatusBarSegments();
			const cfg = deps.statusBar;
			const activeModel = deps.planMode && deps.planModel ? deps.planModel : session.model;
			const ctxForCurrent: SegmentContext = {
				persona: deps.currentPersona.label,
				planMode: deps.planMode,
				activeModel,
				configuredModel: session.model,
				planModel: deps.planModel,
				usage: session.usage,
				lastTurnUsage: agent.lastTurnUsage ? { tokensPerSecond: agent.lastTurnUsage.tokensPerSecond } : undefined,
				elapsedMs: agent.getElapsedMs(),
				messageCount: countTurnMessages(session.messages),
				contextWindow: config.contextWindow,
				maxResponseTokens: config.maxResponseTokens,
				messages: session.messages,
				sessionId: session.id,
			};
			// Build ordered list from statusBar.order, then append any new segments
			const ordered: StatusBarSegment[] = cfg.order
				.map((id) => allSegs.find((s) => s.id === id))
				.filter(Boolean) as StatusBarSegment[];
			for (const seg of allSegs) {
				if (!ordered.some((s) => s.id === seg.id)) ordered.push(seg);
			}
			const lines: string[] = [];
			lines.push(`  ${"Session".padEnd(16)} ${session.id}`);
			for (const seg of ordered) {
				const value = seg.formatValue(ctxForCurrent) ?? "—";
				lines.push(`  ${seg.label.padEnd(16)} ${value}`);
			}
			deps.agent.addDisplayMessage({ role: "warning", content: `Current\n${lines.join("\n")}` });
			return;
		},
	},
	{
		match: (input) => input === "/sessions",
		run: async ({ deps, agent, session, config, showNotice }) => {
			const chosen = await selectSession(deps.pickers);
			if (!chosen) {
				showNotice("[Cancelled — current session unchanged]");
				return;
			}
			if (chosen.id === session.id) {
				showNotice("[Already in that session.]");
				return;
			}
			if (session.messages.length > 0) saveSession(session);
			const fallbackModel = session.model;
			const providerMatches = chosen.providerUrl === config.baseURL;
			const restoredModel = providerMatches ? chosen.model : fallbackModel;
			restoreSessionState(session, { ...chosen, model: restoredModel, providerUrl: config.baseURL });
			if (!providerMatches && chosen.model !== fallbackModel) {
				showNotice(`[Session model "${chosen.model}" belongs to another provider — keeping "${fallbackModel}".]`);
			}
			// Mode travels with the session: restore what the resumed session was
			// left in instead of carrying over the current one.
			deps.setPlanMode(chosen.mode === "plan");
			let personaOpts = deps.personaOptions;
			let contextFilesSuffix: string | undefined;
			let rulesSuffix: string | undefined;
			let rulesLazySuffix: string | undefined;
			let skillsPromptSuffix: string | undefined;
			if (chosen.cwd && chosen.cwd !== deps.cwd) {
				deps.setCwd(chosen.cwd);
				const trusted = await resolveProjectTrustForCwd(deps.projectDeps, chosen.cwd);
				deps.setProjectTrusted(trusted);
				const resolved = await resolveSkillsForCwd(deps.projectDeps, chosen.cwd, trusted);
				deps.setSkills(resolved.skills);
				skillsPromptSuffix = resolved.skillsPromptSuffix;
				deps.setSkillsPromptSuffix(skillsPromptSuffix);
				contextFilesSuffix = formatContextFilesForPrompt(loadProjectContextFiles(chosen.cwd, trusted));
				deps.setContextFilesSuffix(contextFilesSuffix);
				const resolvedRules = resolveRulesForCwd(chosen.cwd, trusted);
				rulesSuffix = resolvedRules.alwaysApplySuffix;
				rulesLazySuffix = resolvedRules.lazySuffix;
				deps.setRulesSuffix(rulesSuffix);
				deps.setRulesLazySuffix(rulesLazySuffix);
				deps.setDirectoryRules(resolvedRules.directoryRules);
				deps.setActiveAutoRules([]);
				deps.setSshHosts(resolveSshHosts(chosen.cwd, trusted));
				const newPersonaOpts = personaOptionsForCwd(chosen.cwd, trusted);
				deps.setPersonaOptions(newPersonaOpts);
				personaOpts = newPersonaOpts;
				await closeMcpConnections(deps.mcpResult.connections);
				deps.setMcpResult(
					await resolveMcpForCwd(deps.projectDeps, chosen.cwd, trusted, loadSettings().disabledMcpServers ?? []),
				);
			}
			// Persona travels with the session, same as mode: reopening a thread
			// under whatever persona is currently active silently swaps the system
			// prompt out from under the history. A deleted persona (or a legacy
			// session without the field) keeps the current one.
			let restoredPersona: Persona | undefined;
			if (chosen.persona && chosen.persona !== deps.currentPersona.name) {
				const sessionPersona = findPersona(chosen.persona, personaOpts);
				if (sessionPersona) {
					deps.setCurrentPersona(sessionPersona);
					restoredPersona = sessionPersona;
				} else {
					showNotice(
						`[Session's persona "${chosen.persona}" no longer exists — keeping ${deps.currentPersona.label}.]`,
					);
					session.persona = deps.currentPersona.name;
				}
			}
			rebuildSystemPrompt(deps, chosen.cwd || deps.cwd, {
				contextFilesSuffix,
				rulesSuffix,
				rulesLazySuffix,
				skillsPromptSuffix,
				...(restoredPersona ? { persona: restoredPersona } : {}),
			});
			agent.refresh();
			const personaNote = restoredPersona ? ` · persona: ${restoredPersona.label}` : "";
			showNotice(`[Switched to session: ${session.id} (${session.messages.length} messages)${personaNote}]`);
			return;
		},
	},
	{
		match: (input) => input === "/rules" || input === "/rules list",
		run: ({ input, deps }) => {
			deps.agent.addDisplayMessage({ role: "user", content: input });
			if (deps.directoryRules.length === 0) {
				deps.agent.addDisplayMessage({
					role: "warning",
					content: "No rules loaded. Create .cast/rules/*.md files to add rules.",
				});
			} else {
				const stickyIds = new Set(deps.activeAutoRules.map((r) => r.id));
				const lines = deps.directoryRules.map((r) => {
					let tag: string;
					if (r.applyMode === "always") {
						tag = " [always]";
					} else if (r.applyMode === "auto") {
						tag = stickyIds.has(r.id) ? " [auto:sticky]" : " [auto:globs]";
					} else if (r.applyMode === "lazy") {
						tag = " [lazy]";
					} else {
						tag = " [manual]";
					}
					const globs = r.globs.length > 0 ? ` globs=${JSON.stringify(r.globs)}` : "";
					const scope = r.scope ? ` scope=${r.scope}` : "";
					return `  ${r.id}${tag}${globs}${scope} (${r.source}) — ${r.description || "no description"}`;
				});
				deps.agent.addDisplayMessage({ role: "warning", content: `Rules\n${lines.join("\n")}` });
			}
			return;
		},
	},
	{
		match: (input) => input === "/repo",
		run: ({ input, deps }) => {
			let isGit = false;
			let branch = "—";
			let dirty = "—";
			let remote = "—";
			let head = "—";
			try {
				execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
					cwd: deps.cwd,
					encoding: "utf8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				isGit = true;
				branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
					cwd: deps.cwd,
					encoding: "utf8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				const status = execFileSync("git", ["status", "--porcelain"], {
					cwd: deps.cwd,
					encoding: "utf8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				dirty = status.trim() ? "true" : "false";
				try {
					remote = execFileSync("git", ["remote", "get-url", "origin"], {
						cwd: deps.cwd,
						encoding: "utf8",
						timeout: 3000,
						stdio: ["pipe", "pipe", "pipe"],
					}).trim();
				} catch {
					// no remote
				}
				const log = execFileSync("git", ["log", "-1", "--pretty=%h %s"], {
					cwd: deps.cwd,
					encoding: "utf8",
					timeout: 3000,
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				if (log) head = log;
			} catch {
				// not a git repo
			}
			deps.agent.addDisplayMessage({ role: "user", content: input });
			deps.agent.addDisplayMessage({
				role: "warning",
				content: `cwd: ${deps.cwd}\ngit: ${isGit}\ngit branch: ${branch}\ndirty: ${dirty}\nremote: ${remote}\nhead: ${head}`,
			});
			return;
		},
	},
	{
		match: (input) => input === "/evolve",
		run: async ({ input, deps, showNotice }) => {
			if (deps.running) {
				showNotice("[Agent is running — wait for it to finish before /evolve]");
				return;
			}
			deps.agent.addDisplayMessage({ role: "user", content: input });
			try {
				const result = await deps.agent.runCommand("/evolve");
				if (typeof result === "string" && result) showNotice(`[${result}]`);
				// Otherwise the daemon set a multi-select question; the decision_state
				// event opens the picker automatically.
			} catch (err) {
				showNotice(`[${err instanceof Error ? err.message : String(err)}]`);
			}
			return;
		},
	},
	{
		match: (input) => input === "/review",
		run: async ({ input, images, deps, agent, showNotice }) => {
			if (deps.running) {
				showNotice("[Agent is running — wait for it to finish, or use /steer, before /review]");
				return;
			}
			deps.agent.addDisplayMessage({ role: "user", content: input });
			await agent.submit(REVIEW_PROMPT, images);
			return;
		},
	},
	{
		match: (input) => input === "/goal" || input.startsWith("/goal "),
		run: async ({ input, images, deps, agent, showNotice }) => {
			const raw = input === "/goal" ? "" : input.slice("/goal ".length);
			const { goal: goalText, maxIterations } = parseGoalInput(raw);
			if (!goalText) {
				showNotice(
					"[Usage: /goal [N] <what to achieve> — works autonomously until done (or /goal --steps N <desc>)]",
				);
				return;
			}
			if (deps.running) {
				showNotice("[Agent is running — wait for it to finish, or use /steer, before /goal]");
				return;
			}
			deps.agent.addDisplayMessage({ role: "user", content: input });
			// goal=<number> tells the daemon to cap the turn's iterations so the
			// autonomous run can't loop forever, and uses the requested budget.
			await agent.submit(buildGoalPrompt(goalText, maxIterations), images, maxIterations);
			return;
		},
	},
	{
		match: (input) => input === "/help",
		run: ({ input, deps }) => {
			deps.agent.addDisplayMessage({ role: "user", content: input });
			deps.agent.addDisplayMessage({
				role: "warning",
				content:
					"Commands\n" +
					"  /build              Exit plan mode, restore full toolset\n" +
					"  /copy               Copy last assistant response\n" +
					"  /current            Show all status bar data\n" +
					"  /clear              Clear context\n" +
					"  /compact            Compact context now\n" +
					"  /continue           Resume the most recent session\n" +
					"  /fork               Fork current safe context into a new session\n" +
					"  /new                Start new session\n" +
					"  /plan               Enter plan mode (explore + plan only)\n" +
					"  /plan-model [m|off] Show or change the plan-mode model\n" +
					"  /abort              Abort running agent (alias: /stop)\n" +
					"  /queue (/q)         Queue message for next turn\n" +
					"  /queue-reset (/qr)  Clear queue\n" +
					"  /steer (/s)         Inject message into running turn\n" +
					"  /model [name]       Show/change model\n" +
					"  /subagent-model [name]  Show/change subagent model\n" +
					"  /reasoning [level]  Show/change reasoning level\n" +
					"  /persona [name]     Show/change persona\n" +
					"  /skills …           Toggle / list / enable|disable / uninstall (/skills help)\n" +
					"  /mcp …              Toggle / list / enable|disable / uninstall (/mcp help)\n" +
					"  /hooks              List hooks; /hooks enable|disable <id>\n" +
					"  /reload             Re-scan skills, MCP, rules\n" +
					"  /<skill-id>         Invoke a loaded skill directly (also: /skill:<name>)\n" +
					"  /rule:<name>        Invoke a rule\n" +
					"  /provider [name]    Switch / add / delete providers\n" +
					"  /permissions        Change bash confirmation mode\n" +
					"  /web                Toggle web tools (web_search, web_fetch)\n" +
					"  /memory             Toggle durable project memory\n" +
					"  /web-search-provider    Switch web_search backend (DuckDuckGo / Tavily / Brave)\n" +
					"  /web-fetch-provider     Switch web_fetch backend (Jina Reader / local)\n" +
					"  /ssh                Manage SSH hosts (list, add, remove)\n" +
					"  /statusbar          Toggle and reorder status bar segments\n" +
					"  /worktree <name>    Switch session into a git worktree (creates it on first use, reuses on resume)\n" +
					"  /theme              Change color theme\n" +
					"  /current            Show all status bar data\n" +
					"  /sessions           List/switch sessions\n" +
					"  /rules              List loaded rules\n" +
					"  /repo               Show cwd and git branch\n" +
					"  /keys               List keybindings\n" +
					"  /quit               Save and exit (alias: /exit)",
			});
			return;
		},
	},
	{
		match: (input) => input.startsWith("/rule:"),
		run: async ({ input, deps, agent, showNotice }) => {
			const ruleName = input.slice("/rule:".length).trim();
			if (!ruleName) {
				showNotice("[Usage: /rule:<name>]");
				return;
			}
			// Prefer an exact id match (scope-qualified, e.g. apps/web/style), then
			// fall back to the bare name (first match) for the common flat case.
			const rule =
				deps.directoryRules.find((r) => r.id === ruleName) ?? deps.directoryRules.find((r) => r.name === ruleName);
			if (!rule) {
				showNotice(`[No rule named "${ruleName}". Use /rules to list available.]`);
				return;
			}
			fireUserPromptExpansion(deps, rule.name);
			await agent.submit(formatRuleInvocation(rule));
			return;
		},
	},
	{
		match: (input) => input === "/keys",
		run: ({ input, deps }) => {
			deps.agent.addDisplayMessage({ role: "user", content: input });
			const ACTION_LABELS: Record<string, string> = {
				"editor.cursorUp": "Cursor up",
				"editor.cursorDown": "Cursor down",
				"editor.cursorLeft": "Cursor left",
				"editor.cursorRight": "Cursor right",
				"editor.cursorWordLeft": "Word left",
				"editor.cursorWordRight": "Word right",
				"editor.cursorLineStart": "Line start",
				"editor.cursorLineEnd": "Line end",
				"editor.deleteCharBackward": "Delete char",
				"editor.deleteCharForward": "Delete forward",
				"editor.deleteWordBackward": "Delete word",
				"editor.deleteWordForward": "Delete word forward",
				"editor.deleteToLineStart": "Delete to line start",
				"editor.deleteToLineEnd": "Delete to line end",
				"input.submit": "Submit",
				"input.abort": "Exit (2× to confirm)",
				"input.escape": "Stop turn / clear input",
				"input.attachImage": "Attach image",
				"input.tab": "Autocomplete",
			};
			const KEY_LABELS: Record<string, string> = {
				up: "↑",
				down: "↓",
				left: "←",
				right: "→",
				enter: "Enter",
				backspace: "Backspace",
				delete: "Del",
				escape: "Esc",
				tab: "Tab",
				home: "Home",
				end: "End",
				"ctrl+c": "Ctrl+C",
				"ctrl+d": "Ctrl+D",
				"ctrl+w": "Ctrl+W",
				"ctrl+u": "Ctrl+U",
				"ctrl+k": "Ctrl+K",
				"ctrl+b": "Ctrl+B",
				"ctrl+f": "Ctrl+F",
				"ctrl+a": "Ctrl+A",
				"ctrl+e": "Ctrl+E",
				"ctrl+g": "Ctrl+G",
				"alt+b": "Alt+B",
				"alt+f": "Alt+F",
				"alt+d": "Alt+D",
				"alt+left": "Alt+←",
				"alt+right": "Alt+→",
				"alt+backspace": "Alt+Backspace",
				"alt+delete": "Alt+Del",
				"ctrl+left": "Ctrl+←",
				"ctrl+right": "Ctrl+→",
			};
			const lines = Object.entries(TUI_KEYBINDINGS).map(([id, def]) => {
				const label = ACTION_LABELS[id] ?? id;
				const rawKeys = Array.isArray(def.defaultKeys) ? def.defaultKeys : [def.defaultKeys];
				const keys = rawKeys.map((k) => KEY_LABELS[k] ?? k).join(" / ");
				return `  ${label.padEnd(22)} ${keys}`;
			});
			const header = "Keybindings";
			// Esc and Ctrl+C are context-dependent (a single label can't capture it):
			// spell out what each does while a turn is running vs idle.
			const notes =
				"\n\n  Esc      stops the current turn while generating; clears the input otherwise" +
				"\n  Ctrl+C   press twice within 2s to exit (does not stop a turn — use Esc for that)";
			deps.agent.addDisplayMessage({
				role: "warning",
				content: `${header}\n${lines.join("\n")}${notes}`,
			});
			return;
		},
	},
];

/**
 * Can the composer send this mid-turn? Derived from the routes themselves, so
 * a command that survives a running turn cannot drift out of the composer's
 * allowed list (they were two hand-maintained lists before).
 */
export function canSubmitDuringRun(text: string): boolean {
	const input = text.trim();
	if (!input.startsWith("/")) return false;
	return COMMAND_ROUTES.some((route) => route.whileRunning === "submit" && route.match(input));
}

/**
 * Route a line of user input. Every slash command is handled
 * here (parity or it's a bug); non-slash input goes to the agent as a prompt.
 */
export async function handleInput(text: string, images: PendingImage[] | undefined, deps: CommandDeps): Promise<void> {
	const { agent, session, config, running, onQuit, showNotice } = deps;
	const input = text.trim();

	if (!input) return;

	if (!input.startsWith("/")) {
		await agent.submit(text, images);
		return;
	}

	const route = COMMAND_ROUTES.find((candidate) => candidate.match(input));
	if (route) {
		if (running && !route.whileRunning) {
			showNotice(BUSY_NOTICE);
			return;
		}
		await route.run({ input, text, images, deps, agent, session, config, running, onQuit, showNotice });
		return;
	}

	// No route claimed it, so what is left is a native skill invocation or plain
	// text — both of which are work, and wait for the turn like any prompt.
	if (running) {
		showNotice(BUSY_NOTICE);
		return;
	}

	// Native `/<skill-id>` invocation — the same body as `/skill:<name>`, just
	// reached without the prefix. Only after every route above declined, so a
	// skill can never shadow a built-in command.
	const spaceIdx = input.indexOf(" ");
	const skillId = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).slice(1);
	if (skillId) {
		const skillArgs = spaceIdx === -1 ? undefined : input.slice(spaceIdx + 1).trim();
		const skill = deps.skills.find((s) => s.name === skillId && s.userInvocable);
		if (skill) {
			fireUserPromptExpansion(deps, skill.name);
			await agent.submit(await renderSkillInvocation(skill, skillArgs, session.id, { projectDir: deps.cwd }));
			return;
		}
	}

	// Unknown slash command — submit to agent as regular text (could be a
	// file path starting with /, e.g. /tmp/cast-clipboard-UUID.png).
	await agent.submit(text);
}
