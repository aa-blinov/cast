import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";

const html = htm.bind(h);

const SETTINGS_TABS = [
	{ id: "appearance", label: "Appearance" },
	{ id: "bash", label: "Bash" },
	{ id: "default-ui", label: "Default UI" },
	{ id: "hooks", label: "Hooks" },
	{ id: "marketplace", label: "Marketplace" },
	{ id: "memory", label: "Memory" },
	{ id: "mcp", label: "MCP" },
	{ id: "model", label: "Model" },
	{ id: "personas", label: "Personas" },
	{ id: "plugins", label: "Plugins" },
	{ id: "provider", label: "Provider" },
	{ id: "skillssh", label: "Skills.sh" },
	{ id: "quick-mode", label: "Quick Mode" },
	{ id: "server", label: "Server" },
	{ id: "skills", label: "Skills" },
	{ id: "ssh", label: "SSH" },
	{ id: "updates", label: "Updates" },
	{ id: "web", label: "Web" },
];

// A centered modal, same treatment as the Hotkeys reference — an anchored
// corner dropdown doesn't have anywhere safe to sit on a narrow screen (the
// status button lives among 3 others in the header, nowhere near the actual
// right edge, so "align to the button" pushed it half off the left side of
// the viewport on mobile). Status is a glance-and-close read either way, so
// a modal costs nothing here and works identically at any viewport width.
// Reloads on every open since usage/message-count/git-dirty drift constantly.
// Everything that used to be a slash command typed into the composer but
// isn't part of the actual back-and-forth with the agent (MCP/skills/
// plugins/provider/SSH management, theme, model/reasoning details, usage) —
// consolidated here so the chat transcript stays just the conversation.
// Every action still runs through the exact same POST /command endpoint the
// composer used, just without ever appending a chat notice for it.
export function SettingsModal({
	panels,
	fontOptions,
	fontScales,
	activeId,
	personas,
	onQuickSessionPersonaChange,
	themes,
	currentThemeId,
	onApplyTheme,
	onThemeChange,
	currentFontId,
	currentFontScale,
	onPickFont,
	onPickScale,
	onClose,
	confirm,
	onReload,
	onModelChange,
	showReasoning,
	onToggleShowReasoning,
	onMemoryChange,
}) {
	const [customCss, setCustomCss] = useState(() => {
		try { return localStorage.getItem("cast:customCss") || ""; } catch { return ""; }
	});
	const saveCustomCss = useCallback((css) => {
		setCustomCss(css);
		try {
			let el = document.getElementById("cast-custom-css");
			if (!css) { if (el) el.remove(); localStorage.removeItem("cast:customCss"); return; }
			if (!el) { el = document.createElement("style"); el.id = "cast-custom-css"; document.head.appendChild(el); }
			el.textContent = css;
			localStorage.setItem("cast:customCss", css);
		} catch {}
	}, []);
	const getInitialTab = () => {
		try {
			const url = new URL(window.location.href);
			const tabParam = url.searchParams.get("tab") || url.pathname.split("/settings/")[1]?.split("/")[0];
			if (tabParam && SETTINGS_TABS.some((t) => t.id === tabParam)) return tabParam;
			const stored = localStorage.getItem("cast:settingsTab");
			if (stored && SETTINGS_TABS.some((t) => t.id === stored)) return stored;
		} catch {}
		return SETTINGS_TABS[0].id;
	};
	const [tab, setTabState] = useState(getInitialTab);
	const setTab = useCallback((id) => {
		setTabState(id);
		try {
			localStorage.setItem("cast:settingsTab", id);
			const url = new URL(window.location.href);
			url.searchParams.set("tab", id);
			window.history.replaceState({}, "", url.toString());
		} catch {}
	}, []);
	const [data, setData] = useState({});
	const [errors, setErrors] = useState({});
	const [busy, setBusy] = useState(false);
	const loadVersions = useRef(new Map());

	const run = useCallback(
		async (command) => {
			try {
				const endpoint = activeId ? `/api/sessions/${activeId}/command` : "/api/settings/command";
				return await api("POST", endpoint, { command });
			} catch (err) {
				return { ok: false, error: err.message };
			}
		},
		[activeId],
	);

	const load = useCallback(
		async (t) => {
			// Initial preloading and post-mutation refreshes race by design. Only
			// the newest request for a resource may update its visible state.
			const version = (loadVersions.current.get(t) || 0) + 1;
			loadVersions.current.set(t, version);
			const isCurrent = () => loadVersions.current.get(t) === version;
			const commit = (update) => {
				if (isCurrent()) setData(update);
			};
			const setLoadError = (error) => {
				if (isCurrent()) setErrors((e) => ({ ...e, [t]: error }));
			};
			setErrors((e) => ({ ...e, [t]: null }));
			if (t === "model") {
				const [models, reasoning, current, providers] = await Promise.all([
					api("GET", "/api/models/cached").catch(() => null),
					api(
						"GET",
						activeId ? `/api/sessions/${activeId}/reasoning-options` : "/api/settings/reasoning-options",
					).catch(() => null),
					run("/current"),
					run("/provider list"),
				]);
				commit((d) => ({
					...d,
					model: {
						models: models?.models ?? [],
						reasoningOptions: reasoning?.options ?? [],
						current: current?.result,
						providers: providers?.result ?? [],
					},
				}));
			} else if (t === "bash") {
				// /current carries maxTurnIterations (turnIterationCap); the cap
				// input must reflect the real value or a save looks like it never
				// happened (the field keeps showing 500).
				const [permissions, current] = await Promise.all([run("/permissions"), run("/current")]);
				commit((d) => ({
					...d,
					bash: { permissions: permissions?.result, maxTurnIterations: current?.result?.maxTurnIterations },
				}));
			} else if (t === "web") {
				const [webTools, searchProvider, fetchProvider] = await Promise.all([
					run("/web"),
					run("/web-search-provider"),
					run("/web-fetch-provider"),
				]);
				commit((d) => ({
					...d,
					web: {
						webTools: webTools?.result,
						searchProvider: searchProvider?.result,
						fetchProvider: fetchProvider?.result,
					},
				}));
			} else if (t === "memory") {
				const res = await run("/memory");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, memory: res.result }));
			} else if (t === "quick-mode") {
				const res = await run("/quick-session-persona");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, "quick-mode": { quickSessionPersona: res.result } }));
			} else if (t === "server") {
				const res = await api("GET", "/api/server/status").catch(() => null);
				commit((d) => ({ ...d, server: res ?? { running: false } }));
			} else if (t === "hooks") {
				const res = await run("/hooks");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, hooks: res.result }));
			} else if (t === "mcp") {
				const res = await run("/mcp list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, mcp: res.result }));
			} else if (t === "skills") {
				const res = await run("/skills list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, skills: res.result }));
			} else if (t === "skillssh") {
				// Reuses the same data as the Skills tab — Skills.sh skills are
				// already loaded from ~/.config/agents/skills/ as part of the
				// agentsGlobalDirs list.
				const res = await run("/skills list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, skills: res.result, skillssh: true }));
			} else if (t === "plugins") {
				const res = await run("/plugin list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({
					...d,
					plugins: {
						plugins: res.result,
					},
				}));
			} else if (t === "marketplace") {
				const [marketplaces, catalog] = await Promise.all([
					run("/plugin marketplace list"),
					run("/plugin marketplace catalog"),
				]);
				// A silently-empty list here reads as "no marketplaces configured"
				// — indistinguishable from an actual fetch failure (e.g. one
				// marketplace's git remote is now unreachable) without this check.
				if (!marketplaces.ok || !catalog.ok) {
					setLoadError(marketplaces.error || catalog.error);
					return;
				}
				commit((d) => ({
					...d,
					marketplace: {
						marketplaces: marketplaces.result,
						catalog: catalog.result,
					},
				}));
			} else if (t === "provider") {
				const res = await run("/provider list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, provider: res.result }));
			} else if (t === "ssh") {
				const res = await run("/ssh list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, ssh: res.result }));
			}
		},
		[run, activeId],
	);

	// Lazy load — only the visible tab is fetched. Preloading all 15 tabs
	// in parallel on open spiked 7+ concurrent `POST /command` + `GET` calls
	// and left the modal in "Loading" on slow networks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: tab is the trigger, activeId via load()'s closure
	useEffect(() => {
		if (tab === "appearance" || tab === "personas" || tab === "updates" || tab === "default-ui") return;
		load(tab);
	}, [tab, activeId, load]);
	const modalRef = useModalFocusTrap(true);
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Runs a mutating command, shows any error inline, and reloads the
	// current tab's data on success so the list reflects the new state
	// immediately instead of waiting for the next manual refresh.
	const act = useCallback(
		async (command) => {
			const actionTab = tab;
			setBusy(true);
			setErrors((e) => ({ ...e, [actionTab]: null }));
			try {
				const res = await run(command);
				if (!res.ok) setErrors((e) => ({ ...e, [tab]: res.error ?? "Failed" }));
				// Refresh the current tab, and the Model tab too when the command
				// actually affects it (a /provider Switch changes the active
				// provider, which the Model picker's model list depends on).
				// Non-model saves (Bash cap, memory numbers) skip the extra round
				// trip so the input doesn't stay disabled waiting on unrelated
				// fetches — that latency read as "медлаей" on every numeric field.
				const affectsModel =
					actionTab === "model" ||
					actionTab === "provider" ||
					/^\/(provider|model|model-selection|reasoning)\b/.test(command);
				await Promise.all([
					load(actionTab),
					affectsModel && actionTab !== "model" ? load("model") : Promise.resolve(),
				]);
				// /reload and any /skills mutation can change which skills are
				// loaded/enabled — those show up as native /<skill-id> slash commands,
				// so the composer's palette needs to catch up too.
				// Same for /plugin install/uninstall/enable/disable — they change
				// which hooks appear in the Hooks tab AND which plugins the
				// Marketplace tab lists as installed (the Marketplace tab derives
				// its "installed" label from data.plugins, so without a reload the
				// just-installed plugin would still show the Install button).
				if (res.ok) {
					if ((command.startsWith("/model ") || command.startsWith("/model-selection ")) && typeof res.result?.model === "string") {
						onModelChange?.(res.result.model);
					}
					if (command.startsWith("/memory ") && typeof res.result?.memoryEnabled === "boolean") {
						onMemoryChange?.(res.result.memoryEnabled);
					}
					if (command === "/reload" || command.startsWith("/skills ")) onReload?.();
					if (
						command === "/reload" ||
						command.startsWith("/plugin ") ||
						command.startsWith("/mcp ") ||
						command.startsWith("/skills-sh ")
					) {
						await Promise.all([load("hooks"), load("mcp"), load("skills"), load("plugins")]);
					}
				}
				return res;
			} catch (err) {
				// A failure anywhere above (e.g. a tab reload throwing) must not
				// leave `busy` stuck true forever — every button in the modal
				// would stay disabled until it's closed and reopened.
				const message = err instanceof Error ? err.message : String(err);
				setErrors((e) => ({ ...e, [actionTab]: message }));
				return { ok: false, error: message };
			} finally {
				setBusy(false);
			}
		},
		[run, load, tab, onReload, onModelChange],
	);

	// theme's data comes from the `themes` prop (fetched once at app boot,
	// always present already) rather than the per-tab preload above.
	// theme and font both come from props/local state (fetched once at app
	// boot, or never fetched at all for font — see applyFont) rather than the
	// per-tab preload above.
	const hasData = tab === "appearance" || tab === "personas" || tab === "updates" || tab === "default-ui" || data[tab] !== undefined;

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Settings</span>
					<div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
						<button class="modal-btn" disabled=${busy} onClick=${() => act("/reload")} title="Re-scan .cast/ directories for skills, rules, MCP servers, and personas from disk">Reload resources</button>
						<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
					</div>
				</div>
				<div class="settings-body">
					<div class="settings-tabs">
						${SETTINGS_TABS.map(
							(t) => html`
							<button key=${t.id} class="settings-tab${tab === t.id ? " active" : ""}" onClick=${() => setTab(t.id)}>${t.label}</button>
						`,
						)}
					</div>
					<div class="settings-pane">
						${errors[tab] && html`<div class="settings-error">${errors[tab]}</div>`}
						${
							!hasData
								? html`<div class="settings-loading">Loading</div>`
								: tab === "appearance"
									? html`<${panels.SettingsAppearance} themes=${themes} currentThemeId=${currentThemeId} fontOptions=${fontOptions} fontScales=${fontScales} onPickTheme=${async (
											id,
										) => {
											const res = await act(`/theme ${id}`);
											if (res.ok && res.result?.colors) onApplyTheme(res.result.colors);
											if (res.ok && res.result?.theme) onThemeChange(res.result.theme);
																	}} currentFontId=${currentFontId} currentFontScale=${currentFontScale} onPickFont=${onPickFont} onPickScale=${onPickScale} showReasoning=${showReasoning} onToggleShowReasoning=${onToggleShowReasoning} customCss=${customCss} onSaveCustomCss=${saveCustomCss} />`
									: tab === "model"
										? html`<${panels.SettingsModel} data=${data.model} busy=${busy} act=${act} />`
										: tab === "personas"
											? html`<${panels.SettingsPersonas} personas=${personas} />`
											: tab === "bash"
											? html`<${panels.SettingsBash} data=${data.bash} busy=${busy} act=${act} />`
									: tab === "web"
										? html`<${panels.SettingsWeb} data=${data.web} busy=${busy} act=${act} />`
										: tab === "memory"
											? html`<${panels.SettingsMemory} data=${data.memory} busy=${busy} act=${act} />`
											: tab === "quick-mode"
													? html`<${panels.SettingsQuickMode} data=${data["quick-mode"]} busy=${busy} act=${act} personas=${personas} onQuickSessionPersonaChange=${onQuickSessionPersonaChange} />`
													: tab === "server"
														? html`<${panels.SettingsServer} data=${data.server} />`
														: tab === "hooks"
															? html`<${panels.SettingsHooks} data=${data.hooks} busy=${busy} act=${act} />`
															: tab === "mcp"
																? html`<${panels.SettingsMcp} data=${data.mcp} busy=${busy} act=${act} confirm=${confirm} />`
																: tab === "skills"
																	? html`<${panels.SettingsSkills} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
																	: tab === "plugins"
																		? html`<${panels.SettingsPlugins} data=${data.plugins} busy=${busy} act=${act} confirm=${confirm} />`
																		: tab === "marketplace"
																			? html`<${panels.SettingsMarketplace} data=${data.marketplace} installed=${data.plugins?.plugins ?? []} busy=${busy} act=${act} confirm=${confirm} />`
																			: tab === "skillssh"
																				? html`<${panels.SettingsSkillssh} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
																				: tab === "provider"
																					? html`<${panels.SettingsProvider} data=${data.provider} busy=${busy} act=${act} confirm=${confirm} />`
																					: tab === "ssh"
																						? html`<${panels.SettingsSsh} data=${data.ssh} busy=${busy} act=${act} confirm=${confirm} />`
																						: tab === "default-ui"
																							? html`<${panels.SettingsDefaultUi} />`
																							: tab === "updates"
																								? html`<${panels.SettingsUpdates} />`
																								: null
						}
					</div>
				</div>
			</div>
		</div>
	`;
}
