import type { PermissionMode } from "../core/settings.ts";
import { loadSettings, runningInputMode, turnIterationCap, updateSettings } from "../core/settings.ts";
import type { SettingFollowUp, SettingRow, SettingsForm } from "../pickers/types.ts";
import { PERMISSION_MODES } from "../pickers/types.ts";
import type { CommandDeps } from "./commands.ts";
import { ALL_THEMES, getActiveTheme, setActiveTheme } from "./themes/index.ts";

// What can be set, in one place. Every setting has one setter, and the slash
// command for it (/theme, /permissions, /web) calls the same one, so the settings
// screen and the command cannot come to mean different things.

const DEFAULT_TURN_CAP = 500;

/** Applies a permission mode without asking; `bypass` is asked about first by applyPermissionMode. */
function setPermissionModeNow(deps: CommandDeps, mode: PermissionMode): void {
	deps.setPermissionMode(mode);
	updateSettings({ permissionMode: mode });
	deps.showNotice(`Permission mode: ${mode}`);
}

export async function applyPermissionMode(deps: CommandDeps, newMode: PermissionMode): Promise<void> {
	if (newMode === "bypass" && loadSettings().permissionMode !== "bypass" && deps.permissionMode !== "bypass") {
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
	setPermissionModeNow(deps, newMode);
}

export function setTheme(deps: CommandDeps, id: string): void {
	setActiveTheme(id);
	updateSettings({ theme: id });
	deps.onThemeChange?.();
}

export function setWebTools(deps: CommandDeps, enabled: boolean): void {
	deps.setWebToolsEnabled(enabled);
	updateSettings({ webTools: enabled });
}

/** "10-10000", or "reset" for the default. Returns the new cap, or a reason it was refused. */
export function parseTurnCap(raw: string): { cap: number | undefined } | { error: string } {
	const text = raw.trim().toLowerCase();
	if (text === "reset" || text === "off" || text === "") return { cap: undefined };
	const n = Number(text);
	if (!Number.isInteger(n) || n < 10 || n > 10_000)
		return { error: "Usage: a whole number from 10 to 10000, or reset" };
	return { cap: n };
}

/** Sets the per-turn cap from what was typed (`/turn-cap 800`, or the settings prompt); says what happened. */
export function applyTurnCap(deps: CommandDeps, raw: string): void {
	const parsed = parseTurnCap(raw);
	if ("error" in parsed) {
		deps.showNotice(`[${parsed.error}]`);
		return;
	}
	updateSettings({ maxTurnIterations: parsed.cap });
	deps.showNotice(`[Per-turn cap: ${parsed.cap ?? DEFAULT_TURN_CAP}${parsed.cap === undefined ? " (default)" : ""}]`);
}

/**
 * The rows of the settings screen. `runCommand` runs a slash command for the
 * rows that are a whole flow of their own (model, provider, persona, ...): those
 * open after the screen closes, and the screen comes back after them.
 */
export function buildSettingsForm(deps: CommandDeps, runCommand: (input: string) => Promise<void>): SettingsForm {
	// The transcript's reasoning toggle is the one setting that is not in the file.
	let showReasoning = deps.agent.showReasoning;

	const open = (label: string, value: string, command: string, description?: string): SettingRow => ({
		kind: "open",
		label,
		value,
		description,
		open: () => runCommand(command),
	});

	const memoryToggle = (
		label: string,
		key: "memoryEnabled" | "memoryWriteEnabled" | "memoryDreamAuto" | "memoryDistillAuto",
		fallback: boolean,
		description: string,
	): SettingRow => {
		const on = loadSettings()[key] ?? fallback;
		return {
			kind: "toggle",
			label,
			description,
			value: on,
			set: (value) => {
				updateSettings({ [key]: value });
				return undefined;
			},
		};
	};

	return {
		title: "Settings",
		rows: () => {
			const s = loadSettings();
			const cap = turnIterationCap(s);
			const mode: PermissionMode = s.permissionMode ?? deps.permissionMode;
			const activeTheme = getActiveTheme().id;
			const skillsOff = s.disabledSkills?.length ?? 0;
			const mcpOff = s.disabledMcpServers?.length ?? 0;
			return [
				{ kind: "heading", label: "Session" },
				open(
					"Persona",
					deps.session.persona ?? deps.currentPersona.name,
					"/persona",
					"Who the agent is: prompt, tools, tone",
				),
				open("Model", deps.session.model, "/model", "The model this session talks to"),
				open(
					"Provider",
					s.providerUrl ?? deps.config.baseURL,
					"/provider",
					"Where requests go; add or switch providers",
				),
				open(
					"Reasoning level",
					s.reasoningLevel ?? deps.config.reasoningLevel,
					"/reasoning",
					"How much the model thinks before it answers",
				),
				open(
					"Plan-mode model",
					s.planModel ?? "same as the main model",
					"/plan-model",
					"A stronger model for planning only",
				),
				open(
					"Subagent model",
					s.subagentModel ?? "same as the main model",
					"/subagent-model",
					"What delegated tasks run on",
				),
				{ kind: "heading", label: "Behaviour" },
				{
					kind: "choice",
					label: "Permissions",
					description: "default asks before rm -rf, sudo, force-push; bypass asks nothing",
					value: mode,
					options: PERMISSION_MODES.map((m) => ({ value: m.value, label: m.value })),
					set: (value) => {
						if (value === "bypass") return () => applyPermissionMode(deps, "bypass");
						setPermissionModeNow(deps, "default");
						return undefined;
					},
				},
				{
					kind: "toggle",
					label: "Show reasoning in the transcript",
					description: "The model's thinking, when it sends it",
					value: showReasoning,
					set: (value) => {
						// Against the form's own value: `deps.agent.showReasoning` is the snapshot from when the screen opened.
						if (showReasoning !== value) showReasoning = deps.agent.toggleReasoning();
						return undefined;
					},
				},
				{
					kind: "choice",
					label: "Message while a turn runs",
					description: "steer: the agent reads it on its next step. queue: it runs after the turn ends",
					value: runningInputMode(s),
					options: [
						{ value: "steer", label: "steer" },
						{ value: "queue", label: "queue" },
					],
					set: (value) => {
						updateSettings({ runningInput: value === "queue" ? "queue" : undefined });
						return undefined;
					},
				},
				{
					kind: "toggle",
					label: "Web search and fetch",
					description: "Lets the agent search the web and read pages",
					value: s.webTools === true,
					set: (value) => {
						setWebTools(deps, value);
						return undefined;
					},
				},
				{
					kind: "open",
					label: "Per-turn iteration cap",
					description: "Model calls in one turn before it is stopped as a runaway (10-10000)",
					value: cap === DEFAULT_TURN_CAP ? `${cap} (default)` : String(cap),
					open: async () => {
						const raw = await deps.pickers.promptText(
							"Per-turn iteration cap (10-10000, or reset)",
							String(cap),
							String(DEFAULT_TURN_CAP),
						);
						if (raw !== null) applyTurnCap(deps, raw);
					},
				},
				{
					kind: "toggle",
					label: "Notifications when the window is out of focus",
					value: s.notifications !== false,
					set: (value) => {
						updateSettings({ notifications: value });
						return undefined;
					},
				},
				{ kind: "heading", label: "Memory" },
				memoryToggle(
					"Project memory",
					"memoryEnabled",
					true,
					"Durable notes the agent reads and keeps for this project",
				),
				memoryToggle(
					"Background memory writing",
					"memoryWriteEnabled",
					true,
					"Extraction and checkpoints between turns",
				),
				memoryToggle(
					"Automatic consolidation",
					"memoryDreamAuto",
					false,
					"Merge project memory when a new session starts",
				),
				memoryToggle(
					"Automatic workflow distillation",
					"memoryDistillAuto",
					false,
					"Package repeated workflows into artifacts",
				),
				{ kind: "heading", label: "Appearance" },
				{
					kind: "choice",
					label: "Theme",
					description: "← → try the next one at once; Enter opens the list",
					value: activeTheme,
					options: ALL_THEMES.map((t) => ({ value: t.id, label: t.id })),
					set: (value) => {
						setTheme(deps, value);
						return undefined;
					},
					choose: async () => {
						const picked = await deps.pickers.pickOption(
							ALL_THEMES.map((t) => ({
								value: t.id,
								label: `${t.label}${t.id === activeTheme ? " (current)" : ""}`,
								description: t.description,
							})),
							{ title: "Color themes", defaultIndex: ALL_THEMES.findIndex((t) => t.id === activeTheme) },
						);
						if (picked) setTheme(deps, picked);
					},
				},
				open("Status bar", "segments and their order", "/statusbar", "Which facts show under the input, and where"),
				open(
					"Header",
					"parts and their order",
					"/header",
					"What the top row says: persona, model, version, folder",
				),
				{ kind: "heading", label: "Tools" },
				open(
					"Skills",
					`${deps.skills.length} found${skillsOff ? `, ${skillsOff} off` : ""}`,
					"/skills",
					"Turn skills on and off",
				),
				open(
					"MCP servers",
					`${deps.mcpResult.connections.length} connected${mcpOff ? `, ${mcpOff} off` : ""}`,
					"/mcp",
					"Turn servers on and off",
				),
				open("Web search provider", s.searchProvider ?? "ddg", "/web-search-provider"),
				open("Web fetch provider", s.webFetchProvider ?? "jina", "/web-fetch-provider"),
				open("SSH hosts", `${deps.sshHosts.length} configured`, "/ssh"),
				open("Keybindings", "list what is bound", "/keys"),
			];
		},
	};
}

/** For a front end with no settings screen: the same rows as a plain list, each acting when picked. */
export async function pickSettingFallback(deps: CommandDeps, form: SettingsForm): Promise<SettingFollowUp | null> {
	const rows = form.rows().filter((r): r is Exclude<SettingRow, { kind: "heading" }> => r.kind !== "heading");
	const label = (r: (typeof rows)[number]) =>
		`${r.label}: ${r.kind === "toggle" ? (r.value ? "on" : "off") : r.value}`;
	const index = await deps.pickers.pickOption(
		rows.map((r, i) => ({ value: i, label: label(r) })),
		{ title: form.title },
	);
	if (index === null) return null;
	const row = rows[index];
	if (!row) return null;
	if (row.kind === "open") return row.open;
	if (row.kind === "toggle") return row.set(!row.value) ?? null;
	if (row.choose) return row.choose;
	const at = row.options.findIndex((o) => o.value === row.value);
	const next = row.options[(at + 1) % row.options.length];
	return next ? (row.set(next.value) ?? null) : null;
}
