import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { shortPath } from "./sidebar-utils.js";

const html = htm.bind(h);

function SettingsServer({ data }) {
	if (!data || !data.running) {
		return html`
			<div class="settings-rows">
				<div class="settings-section-title">Server status</div>
				<p class="settings-hint">No cast server daemon found. Start one with <code>cast server --public</code> in a terminal.</p>
			</div>
		`;
	}
	const startedAt = data.startedAt ? new Date(data.startedAt) : null;
	const uptimeMs = startedAt ? Date.now() - startedAt.getTime() : 0;
	const formatUptime = (ms) => {
		if (ms <= 0) return "—";
		const sec = Math.floor(ms / 1000);
		const days = Math.floor(sec / 86400);
		const hours = Math.floor((sec % 86400) / 3600);
		const mins = Math.floor((sec % 3600) / 60);
		const parts = [];
		if (days) parts.push(`${days}d`);
		if (hours || days) parts.push(`${hours}h`);
		parts.push(`${mins}m`);
		return parts.join(" ");
	};
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Server status</div>
			<p class="settings-hint">The cast server process serving this UI. Same info as <code>cast server status</code> on the command line.</p>
			<div class="settings-compact-list">
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Status</span><span>Running</span></div>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">URL</span><span><code>http://${data.host}:${data.port}</code>${data.host === "0.0.0.0" ? " (reachable from other machines)" : ""}</span></div>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">PID</span><span>${data.pid}${data.foreground ? " (foreground)" : ""}</span></div>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Started</span><span>${startedAt ? startedAt.toLocaleString() : "—"} (uptime: ${formatUptime(uptimeMs)})</span></div>
				</div>
			</div>
		</div>
	`;
}

function SettingsBash({ data, busy, act }) {
	if (!data) return null;
	const perm = data.permissions || {};
	const cap = data.maxTurnIterations ?? 500;
	// Draft is initialized from the real value (loaded via /current) and NOT
	// re-fallen back to `cap` when cleared — otherwise you can never erase the
	// field ("" || cap snaps back to 500) and every keystroke feels like the
	// input is fighting you.
	const [capDraft, setCapDraft] = useState(() => String(cap));
	useEffect(() => {
		if (data.maxTurnIterations !== undefined) setCapDraft(String(data.maxTurnIterations));
	}, [data.maxTurnIterations]);
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Bash confirmation mode</div>
			<p class="settings-hint">Default asks before running potentially dangerous shell commands. Bypass skips all confirmation prompts.</p>
			<div class="settings-form-row">
				<button class="modal-btn${perm.permissionMode === "default" ? " modal-btn-primary" : ""}" title="Confirm dangerous commands" disabled=${busy} onClick=${() => act("/permissions default")}>Default</button>
				<button class="modal-btn${perm.permissionMode === "bypass" ? " modal-btn-primary" : ""}" title="Skip confirmation prompts" disabled=${busy} onClick=${() => act("/permissions bypass")}>Bypass</button>
			</div>
			<div class="settings-section-title">Turn safety cap</div>
			<p class="settings-hint">Max model calls per turn before the loop stops as a runaway (default 500). Applies on the next agent call.</p>
			<div class="settings-inline-form">
				<input aria-label="Turn iteration safety cap" type="number" min="10" max="10000" step="10" value=${capDraft} disabled=${busy} onInput=${(event) => setCapDraft(event.target.value)} />
				<button class="modal-btn icon-btn" title="Reset to 500" disabled=${busy || cap === 500} onClick=${() => act("/turn-cap reset")}><${icons.arrowUturnLeft} /></button>
				<button class="modal-btn icon-btn" title="Save" disabled=${busy || capDraft.trim() === "" || Number(capDraft) === cap} onClick=${() => act(`/turn-cap ${Number(capDraft)}`)}><${icons.check} /></button>
			</div>
		</div>
	`;
}

// Defaults mirrored from src/core/settings.ts / src/core/loop.ts — used to
// decide when a numeric memory setting is "custom" and should show a reset icon.
const DEFAULTS = {
	reserved: 13_000,
	dreamInterval: 7,
	distillInterval: 30,
	budget: 4_096,
	floor: 0.15,
	caps: { checkpoint: 11_000, memory: 10_000, notes: 6_000, global: 6_000, tasks: 2_000 },
};

function SettingsMemory({ data, busy, act }) {
	const budget = data?.memoryPromptBudget ?? DEFAULTS.budget;
	const floor = data?.memorySearchScoreFloor ?? DEFAULTS.floor;
	const dreamInterval = data?.memoryDreamIntervalDays ?? DEFAULTS.dreamInterval;
	const distillInterval = data?.memoryDistillIntervalDays ?? DEFAULTS.distillInterval;
	const reserved = data?.checkpointReserved ?? DEFAULTS.reserved;
	// Numeric drafts are initialized from the real values and only ever set
	// from data — never rendered as `draft || current`. That fallback made a
	// cleared field snap straight back to the current value, so the numbers
	// felt laggy and could never be erased in one pass.
	const [budgetDraft, setBudgetDraft] = useState(() => String(budget));
	const [floorDraft, setFloorDraft] = useState(() => String(floor));
	const [dreamIntervalDraft, setDreamIntervalDraft] = useState(() => String(dreamInterval));
	const [distillIntervalDraft, setDistillIntervalDraft] = useState(() => String(distillInterval));
	const [thresholdsDraft, setThresholdsDraft] = useState("");
	const [reservedDraft, setReservedDraft] = useState(() => String(reserved));
	const [capsDrafts, setCapsDrafts] = useState({});
	useEffect(() => {
		setBudgetDraft(String(budget));
		setFloorDraft(String(floor));
		setDreamIntervalDraft(String(dreamInterval));
		setDistillIntervalDraft(String(distillInterval));
		setReservedDraft(String(reserved));
	}, [budget, floor, dreamInterval, distillInterval, reserved]);
	if (!data) return null;
	const enabled = data.memoryEnabled !== false;
	const writeEnabled = data.memoryWriteEnabled !== false;
	const checkpointFork = data.checkpointFork === true;
	const reconcile = data.memoryReconcileOnSearch !== false;
	const dreamAuto = data.memoryDreamAuto === true;
	const distillAuto = data.memoryDistillAuto === true;
	const thresholds = data.checkpointThresholds ?? [];
	const pushCaps = data.checkpointPushCaps ?? {};
	const setCapDraft = (key) => (event) => setCapsDrafts({ ...capsDrafts, [key]: event.target.value });
	const actCaps = (key) => {
		const value = Number(capsDrafts[key]);
		if (!Number.isFinite(value) || value <= 0) return;
		act(`/memory checkpoint caps ${key}=${Math.floor(value)}`);
		setCapsDrafts({ ...capsDrafts, [key]: "" });
	};
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Durable project memory</div>
			<p class="settings-hint">Project memory is shared with the TUI and saved in <code>~/.cast/settings.json</code>. Reading and background writing can be controlled independently.</p>
			<div class="settings-compact-list">
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Memory</span><span>${enabled ? "Retrieval and the Memory sidebar are active" : "Memory retrieval and the Memory sidebar are disabled"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${enabled ? "true" : "false"} disabled=${busy} onClick=${() => act(`/memory ${enabled ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${enabled ? "Enabled" : "Disabled"}</button>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Background writing</span><span>${writeEnabled ? "The writer and checkpoint agent may update memory" : "Existing memory remains readable; no new memory is written"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${writeEnabled ? "true" : "false"} disabled=${busy || !enabled} onClick=${() => act(`/memory write ${writeEnabled ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${writeEnabled ? "Enabled" : "Disabled"}</button>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Checkpoint prefix fork</span><span>${checkpointFork ? "Checkpoint writers retain the parent prefix for prompt-cache reuse" : "Checkpoint writers receive only the post-checkpoint delta"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${checkpointFork ? "true" : "false"} disabled=${busy || !enabled || !writeEnabled} onClick=${() => act(`/memory checkpoint fork ${checkpointFork ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${checkpointFork ? "Enabled" : "Disabled"}</button>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Checkpoint thresholds</span><span>${thresholds.length > 0 ? `Writer fires at ${thresholds.join("%,")}% of the window` : "Writer fires at the window-based defaults"}</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = thresholdsDraft.trim(); if (value === "default" || value.split(",").every((part) => { const n = Number(part.trim()); return Number.isFinite(n) && n > 0 && n <= 100; })) act(`/memory checkpoint thresholds ${value}`); }}><input aria-label="Checkpoint thresholds" placeholder=${thresholds.length > 0 ? thresholds.join(",") : "default"} value=${thresholdsDraft} disabled=${busy || !enabled || !writeEnabled} onInput=${(event) => setThresholdsDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to window defaults" disabled=${busy || !enabled || !writeEnabled || thresholds.length === 0} onClick=${() => act("/memory checkpoint thresholds default")}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !thresholdsDraft} onClick=${() => act(`/memory checkpoint thresholds ${thresholdsDraft.trim()}`)}><${icons.check} /></button></form>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Checkpoint reserved</span><span>Token safety buffer at the window end; thresholds clamp to window − reserved (default ${DEFAULTS.reserved})</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = Number(reservedDraft); if (Number.isInteger(value) && value >= 0) act(`/memory checkpoint reserved ${value}`); }}><input aria-label="Checkpoint reserved tokens" type="number" min="0" step="1000" value=${reservedDraft} disabled=${busy || !enabled || !writeEnabled} onInput=${(event) => setReservedDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.reserved}" disabled=${busy || !enabled || !writeEnabled || reserved === DEFAULTS.reserved} onClick=${() => act(`/memory checkpoint reserved ${DEFAULTS.reserved}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !reservedDraft || Number(reservedDraft) === reserved} onClick=${() => act(`/memory checkpoint reserved ${Number(reservedDraft)}`)}><${icons.check} /></button></form>
				</div>
				${["checkpoint", "memory", "notes", "global", "tasks"].map((key) => {
					const current = pushCaps[key] ?? DEFAULTS.caps[key];
					return html`<div class="settings-compact-row" key=${`caps-${key}`}>
						<div class="settings-compact-copy"><span class="settings-compact-title">Caps: ${key}</span><span>Rebuild token cap for the ${key} section (default ${DEFAULTS.caps[key]})</span></div>
						<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); actCaps(key); }}><input aria-label=${`Checkpoint ${key} token cap`} type="number" min="1" step="500" placeholder=${current} value=${capsDrafts[key] ?? ""} disabled=${busy || !enabled || !writeEnabled} onInput=${setCapDraft(key)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.caps[key]}" disabled=${busy || !enabled || !writeEnabled || (pushCaps[key] === undefined || pushCaps[key] === DEFAULTS.caps[key])} onClick=${() => act(`/memory checkpoint caps ${key}=${DEFAULTS.caps[key]}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !capsDrafts[key]} onClick=${() => actCaps(key)}><${icons.check} /></button></form>
					</div>`;
				})}
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Automatic dream</span><span>${dreamAuto ? `Consolidates project memory on a new session, at most every ${dreamInterval} day${dreamInterval === 1 ? "" : "s"}` : "Manual only. Enable to consolidate durable project memory on new sessions"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${dreamAuto ? "true" : "false"} disabled=${busy || !enabled || !writeEnabled} onClick=${() => act(`/memory dream ${dreamAuto ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${dreamAuto ? "Enabled" : "Disabled"}</button>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Dream interval</span><span>Minimum days between automatic consolidation runs; 0 runs on every new session</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = Number(dreamIntervalDraft || dreamInterval); if (Number.isInteger(value) && value >= 0 && value <= 3650) act(`/memory dream interval ${value}`); }}><input aria-label="Automatic dream interval days" type="number" min="0" max="3650" step="1" value=${dreamIntervalDraft} disabled=${busy || !enabled || !writeEnabled} onInput=${(event) => setDreamIntervalDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.dreamInterval}" disabled=${busy || !enabled || !writeEnabled || dreamInterval === DEFAULTS.dreamInterval} onClick=${() => act(`/memory dream interval ${DEFAULTS.dreamInterval}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !dreamIntervalDraft || Number(dreamIntervalDraft) === dreamInterval} onClick=${() => act(`/memory dream interval ${Number(dreamIntervalDraft)}`)}><${icons.check} /></button></form>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Automatic distill</span><span>${distillAuto ? `Packages repeated workflows on a new session, at most every ${distillInterval} day${distillInterval === 1 ? "" : "s"}` : "Manual only. Enable to package repeated workflows into reusable assets"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${distillAuto ? "true" : "false"} disabled=${busy || !enabled || !writeEnabled} onClick=${() => act(`/memory distill ${distillAuto ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${distillAuto ? "Enabled" : "Disabled"}</button>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Distill interval</span><span>Minimum days between automatic workflow packaging runs</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = Number(distillIntervalDraft || distillInterval); if (Number.isInteger(value) && value >= 0 && value <= 3650) act(`/memory distill interval ${value}`); }}><input aria-label="Automatic distill interval days" type="number" min="0" max="3650" step="1" value=${distillIntervalDraft} disabled=${busy || !enabled || !writeEnabled} onInput=${(event) => setDistillIntervalDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.distillInterval}" disabled=${busy || !enabled || !writeEnabled || distillInterval === DEFAULTS.distillInterval} onClick=${() => act(`/memory distill interval ${DEFAULTS.distillInterval}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !distillIntervalDraft || Number(distillIntervalDraft) === distillInterval} onClick=${() => act(`/memory distill interval ${Number(distillIntervalDraft)}`)}><${icons.check} /></button></form>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Prompt budget</span><span>Maximum estimated memory tokens added to a model context</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = Number(budgetDraft || budget); if (Number.isInteger(value) && value >= 256) act(`/memory budget ${value}`); }}><input aria-label="Memory prompt token budget" type="number" min="256" max="16384" step="256" value=${budgetDraft} disabled=${busy} onInput=${(event) => setBudgetDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.budget}" disabled=${busy || budget === DEFAULTS.budget} onClick=${() => act(`/memory budget ${DEFAULTS.budget}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !budgetDraft || Number(budgetDraft) === budget} onClick=${() => act(`/memory budget ${Number(budgetDraft)}`)}><${icons.check} /></button></form>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Search score floor</span><span>Drop weak common-word matches below this fraction of the best result</span></div>
					<form class="settings-inline-form" onSubmit=${(event) => { event.preventDefault(); const value = Number(floorDraft || floor); if (value >= 0 && value <= 1) act(`/memory floor ${value}`); }}><input aria-label="Memory search score floor" type="number" min="0" max="1" step="0.05" value=${floorDraft} disabled=${busy} onInput=${(event) => setFloorDraft(event.target.value)} /><button class="modal-btn icon-btn" title="Reset to ${DEFAULTS.floor}" disabled=${busy || floor === DEFAULTS.floor} onClick=${() => act(`/memory floor ${DEFAULTS.floor}`)}><${icons.arrowUturnLeft} /></button><button class="modal-btn icon-btn" title="Save" disabled=${busy || !floorDraft || Number(floorDraft) === floor} onClick=${() => act(`/memory floor ${Number(floorDraft)}`)}><${icons.check} /></button></form>
				</div>
				<div class="settings-compact-row">
					<div class="settings-compact-copy"><span class="settings-compact-title">Reconcile before search</span><span>${reconcile ? "File changes are checked before memory search" : "Search uses the existing SQLite index until the next writer sync"}</span></div>
					<button class="settings-toggle" role="switch" aria-checked=${reconcile ? "true" : "false"} disabled=${busy} onClick=${() => act(`/memory reconcile ${reconcile ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${reconcile ? "Enabled" : "Disabled"}</button>
				</div>
			</div>
		</div>
	`;
}

function SettingsWeb({ data, busy, act }) {
	const [tavilyKey, setTavilyKey] = useState("");
	const [braveKey, setBraveKey] = useState("");
	const [pendingSearchProvider, setPendingSearchProvider] = useState("");
	if (!data) return null;
	const webTools = data.webTools || {};
	const search = data.searchProvider || {};
	const fetchProvider = data.fetchProvider || {};
	const webOn = webTools.webTools;
	const provider = search.searchProvider || "ddg";
	const selectedSearchProvider = pendingSearchProvider || provider;
	const tKey = tavilyKey || search.tavilyApiKey || "";
	const bKey = braveKey || search.braveApiKey || "";
	const fetchBackend = fetchProvider.webFetchProvider || "jina";
	const selectSearchProvider = async (nextProvider) => {
		setPendingSearchProvider(nextProvider);
		if (nextProvider !== "ddg") return;
		const result = await act("/web-search-provider ddg");
		if (result.ok) setPendingSearchProvider("");
	};
	const saveSearchProvider = async () => {
		const key = selectedSearchProvider === "tavily" ? tKey : bKey;
		if (!key) return;
		const result = await act(`/web-search-provider ${selectedSearchProvider} ${key}`);
		if (result.ok) setPendingSearchProvider("");
	};
	return html`
		<div class="settings-compact-list">
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Web tools</span><span>Lets the agent search the web and read pages.</span></div>
				<button class="settings-toggle" role="switch" aria-checked=${webOn ? "true" : "false"} disabled=${busy} onClick=${() => act(`/web ${webOn ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${webOn ? "Enabled" : "Disabled"}</button>
			</div>
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Search</span><span>DuckDuckGo is free but rate-limited; Tavily and Brave need a key.</span></div>
				<select disabled=${busy} value=${selectedSearchProvider} onChange=${(e) => selectSearchProvider(e.target.value)}>
					<option value="ddg">DuckDuckGo</option>
					<option value="tavily">Tavily</option>
					<option value="brave">Brave Search</option>
				</select>
			</div>
			${
				selectedSearchProvider !== "ddg"
					? html`<div class="settings-compact-detail"><form style="display:contents" onSubmit=${(e) => e.preventDefault()}><input type="password" autocomplete="off" placeholder=${selectedSearchProvider === "tavily" ? "Tavily API key (tvly-...)" : "Brave Search API key (BSA...)"} value=${selectedSearchProvider === "tavily" ? tKey : bKey} onInput=${(e) => (selectedSearchProvider === "tavily" ? setTavilyKey(e.target.value) : setBraveKey(e.target.value))} /><button class="modal-btn" disabled=${busy || !(selectedSearchProvider === "tavily" ? tKey : bKey)} onClick=${saveSearchProvider}>Save</button></form></div>`
					: null
			}
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Fetch pages</span><span>${fetchBackend === "jina" ? "Handles JavaScript pages and PDFs; URLs go through Jina Reader." : "Fetches directly from this machine; no third party receives the URL."}</span></div>
				<div class="settings-segmented"><button class="modal-btn${fetchBackend === "jina" ? " modal-btn-primary" : ""}" disabled=${busy} onClick=${() => act("/web-fetch-provider jina")}>Jina</button><button class="modal-btn${fetchBackend === "local" ? " modal-btn-primary" : ""}" disabled=${busy} onClick=${() => act("/web-fetch-provider local")}>Local</button></div>
			</div>
		</div>
	`;
}

function SettingsQuickMode({ data, busy, act, personas, onQuickSessionPersonaChange }) {
	const [quickPersonaValue, setQuickPersonaValue] = useState("");
	if (!data) return null;
	const quickPersona = data.quickSessionPersona?.quickSessionPersona ?? "senior";
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Quick session persona</div>
			<p class="settings-hint">Persona the sidebar's "Quick" button uses — skips the picker, opens straight into a fresh sandbox directory.</p>
			<div class="settings-form-row">
				<select
					disabled=${busy || !(personas || []).length}
					value=${quickPersonaValue || quickPersona}
					onChange=${(e) => setQuickPersonaValue(e.target.value)}
				>
					${(personas || []).map((p) => html`<option key=${p.name} value=${p.name}>${p.label}</option>`)}
				</select>
				<button
					class="modal-btn icon-btn"
					title="Apply quick session persona"
					disabled=${busy || !quickPersonaValue || quickPersonaValue === quickPersona}
					onClick=${async () => {
						const res = await act(`/quick-session-persona ${quickPersonaValue}`);
						if (res.ok) {
							onQuickSessionPersonaChange?.(quickPersonaValue);
							setQuickPersonaValue("");
						}
					}}
				><${icons.check} /></button>
			</div>
		</div>
	`;
}

function SettingsPersonas({ personas = [] }) {
	const groups = [
		{ key: "builtin", label: "Built-in", items: personas.filter((persona) => persona.source === "builtin") },
		{ key: "global", label: "Global", items: personas.filter((persona) => persona.source === "global") },
		{ key: "project", label: "Project", items: personas.filter((persona) => persona.source === "project") },
	];
	const renderPersona = (persona) => html`
		<div key=${persona.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ok" />
				<span class="settings-item-name">${persona.label}</span>
				<span class="settings-item-meta">${persona.name}</span>
				<${InfoPopover}
					text=${persona.description || "No description provided."}
					readUrl=${`/api/persona-content?name=${encodeURIComponent(persona.name)}`}
					contentLabel="Persona content"
				/>
			</div>
		</div>
	`;

	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Agent working styles. Click ℹ for a short description or the book to read the full persona prompt.</span></p>
			${groups
				.filter((group) => group.items.length > 0)
				.map(
					(group) => html`
						<div key=${group.key} class="settings-group">
							<div class="settings-section-title">${group.label}</div>
							${[...group.items].sort((a, b) => a.label.localeCompare(b.label)).map(renderPersona)}
						</div>
					`,
				)}
			${personas.length === 0 && html`<div class="settings-hint">No personas available.</div>`}
		</div>
	`;
}

function SettingsMcp({ data, busy, act, confirm }) {
	const servers = data || [];
	const groups = [
		{ key: "global", label: "Global", items: servers.filter((s) => s.source === "global") },
		{ key: "project", label: "Project", items: servers.filter((s) => s.source === "project") },
	];
	const renderServer = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.connected ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.disabled ? "disabled" : s.connected ? "connected" : "not connected"}</span>
			</div>
			<div class="settings-item-actions">
				${!s.disabled && html`<button class="modal-btn icon-btn" title="Reconnect" disabled=${busy} onClick=${() => act(`/mcp reconnect ${s.name}`)}><${icons.arrowPath} /></button>`}
				<button class="modal-btn icon-btn" title=${s.disabled ? "Enable" : "Disable"} disabled=${busy} onClick=${() => act(`/mcp ${s.disabled ? "enable" : "disable"} ${s.name}`)}>${s.disabled ? html`<${icons.play} />` : html`<${icons.pause} />`}</button>
				<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
					if (await confirm(`Uninstall MCP server "${s.name}"?`)) act(`/mcp uninstall ${s.name}`);
				}}><${icons.trash} /></button>
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Background processes that give the agent extra tools. Configured in <code>.cast/mcp.json</code> (project) or <code>~/.cast/mcp.json</code> (global).</span></p>
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderServer)}
				</div>
			`,
				)}
			${servers.length === 0 && html`<div class="settings-hint">No MCP servers configured.</div>`}
		</div>
	`;
}
function SettingsSkills({ data, busy, act, confirm }) {
	const skills = data || [];
	const groups = [
		{ key: "builtin", label: "Built-in", items: skills.filter((s) => s.source === "builtin") },
		{ key: "global", label: "Global", items: skills.filter((s) => s.source === "global") },
		{
			key: "project",
			label: "Project",
			items: skills.filter((s) => s.source === "project" || s.source === "agents" || s.source === "path"),
		},
		{ key: "plugin", label: "Plugins", items: skills.filter((s) => s.source === "plugin") },
	];
	const renderSkill = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.enabled ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.source === "plugin" && s.pluginId ? s.pluginId : s.source}</span>
				<${InfoPopover} text=${s.description} readUrl=${`/api/skill-content?name=${encodeURIComponent(s.name)}`} />
			</div>
			<div class="settings-item-actions">
				<button class="modal-btn icon-btn" title=${s.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/skills ${s.enabled ? "disable" : "enable"} ${s.name}`)}>${s.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
				${
					s.uninstallable &&
					html`<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
						if (await confirm(`Uninstall skill "${s.name}"?`)) act(`/skills uninstall ${s.name}`);
					}}><${icons.trash} /></button>`
				}
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>On-demand instruction sets — "expertise plugins" the agent picks up when a task matches, or you invoke with <code>/skill-name</code>. Click ℹ to preview one.</span></p>
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderSkill)}
				</div>
			`,
				)}
		</div>
	`;
}

function SettingsHooks({ data, busy, act }) {
	const hooks = data?.entries || [];
	const diagnostics = data?.diagnostics || [];
	// Group plugins by pluginId — each plugin gets its own collapsible subsection.
	// Global/project stay flat since they have no pluginId.
	const globalHooks = hooks.filter((h) => h.source === "global");
	const projectHooks = hooks.filter((h) => h.source === "project");
	const pluginGroups = new Map();
	for (const h of hooks.filter((h) => h.source === "plugin")) {
		const key = h.pluginId ?? "(unknown plugin)";
		if (!pluginGroups.has(key)) pluginGroups.set(key, []);
		pluginGroups.get(key).push(h);
	}
	const renderHook = (h, showPlugin = false) => html`
		<div key=${h.id} class="settings-item-row settings-item-row-stack">
			<div class="settings-item-header">
				<span class="settings-item-status ${h.enabled ? "ok" : "off"}" />
				<span class="settings-item-name">${h.event}${h.matcher ? html` <span style=${{ opacity: 0.6 }}>(${h.matcher})</span>` : ""}</span>
				${showPlugin && h.pluginId ? html`<span class="settings-item-meta">${h.pluginId}</span>` : ""}
				<div class="settings-item-actions">
					<button class="modal-btn icon-btn" title=${h.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/hooks ${h.enabled ? "disable" : "enable"} ${h.id}`)}>${h.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
				</div>
			</div>
			${
				h.commands?.length > 0 &&
				html`
				<div class="settings-item-body">
					${h.commands.map(
						(c) => html`
						<div class="settings-item-cmd">
							<span class="settings-item-cmd-type">${c.type ?? "command"}</span>
							<code>${c.type === "http" ? c.url : c.command}</code>
							${c.if ? html`<span class="settings-item-cmd-if">if: ${c.if}</span>` : ""}
							${c.timeout ? html`<span class="settings-item-cmd-timeout">${c.timeout}s</span>` : ""}
						</div>
					`,
					)}
				</div>
			`
			}
		</div>
	`;
	const renderGroup = (label, items, opts = {}) => {
		if (items.length === 0) return null;
		return html`
			<div key=${opts.key ?? label} class="settings-group">
				<div class="settings-section-title">${label}</div>
				${[...items].sort((a, b) => a.event.localeCompare(b.event)).map((h) => renderHook(h, opts.showPlugin ?? false))}
			</div>
		`;
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Shell (or HTTP) commands that fire on lifecycle events — validate/block a tool call, log activity, or force the agent to keep working before it stops. Configure in <code>.cast/hooks.json</code> (project) or <code>~/.cast/hooks.json</code> (global). Plugin-contributed hooks are grouped under their plugin; uninstall the plugin to remove all its hooks.</span></p>
			${
				diagnostics.length > 0 &&
				html`<div class="settings-error">
					${diagnostics.map((d) => html`<div key=${d.path}>Failed to parse <code>${d.path}</code>: ${d.message}</div>`)}
				</div>`
			}
			${renderGroup("Global", globalHooks, { key: "global" })}
			${renderGroup("Project", projectHooks, { key: "project" })}
			${[...pluginGroups.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([pluginId, items]) => html`
					<div key=${pluginId} class="settings-group">
						<div class="settings-section-title settings-section-title-plugin">
							<span class="settings-section-title-name">${pluginId}</span>
							<span class="settings-section-title-count">${items.length} hook${items.length === 1 ? "" : "s"}</span>
						</div>
						${[...items].sort((a, b) => a.event.localeCompare(b.event)).map((h) => renderHook(h, false))}
					</div>
				`,
				)}
			${hooks.length === 0 && html`<div class="settings-hint">No hooks configured.</div>`}
		</div>
	`;
}

function SettingsSkillssh({ data, busy, act, confirm }) {
	const [installArgs, setInstallArgs] = useState("");
	const [installing, setInstalling] = useState(false);
	const [installFeedback, setInstallFeedback] = useState(null);
	const allSkills = data || [];
	// Filter to skills installed via npx skills add (flagged by the bridge)
	const shSkills = allSkills.filter((s) => s.skillssh);
	const install = async () => {
		if (!installArgs || busy || installing) return;
		setInstalling(true);
		setInstallFeedback(null);
		try {
			const res = await act(`/skills-sh install ${installArgs}`);
			if (res.ok) {
				setInstallArgs("");
				// Surface stdout even on success — it contains "Failed to install 1" etc.
				if (res.result) setInstallFeedback({ ok: true, text: String(res.result).slice(0, 3000) });
			} else {
				setInstallFeedback({ ok: false, text: String(res.error || "Install failed").slice(0, 3000) });
			}
		} catch (err) {
			setInstallFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
		} finally {
			setInstalling(false);
		}
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span><a href="https://skills.sh" target="_blank" rel="noopener">skills.sh</a> is the open agent-skills ecosystem (70+ agents, 27k stars) — browse it there for a package name, then install below. Cast already loads anything in <code>~/.agents/skills/</code> automatically.</span></p>

			<div class="settings-section-title">Install a skill</div>
			<div class="settings-form-row">
				<input type="text" placeholder="owner/repo --skill name (or paste skills.sh's npx command)" value=${installArgs} disabled=${installing} onInput=${(e) => { setInstallArgs(e.target.value); if (installFeedback) setInstallFeedback(null); }} onKeyDown=${(
					e,
				) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void install();
					}
				}} />
				<button class="modal-btn icon-btn" title=${installing ? "Installing skill" : "Run npx skills add -g"} aria-busy=${installing} disabled=${busy || installing || !installArgs} onClick=${install}>${installing ? html`<span class="settings-inline-loader" aria-label="Installing" />` : html`<${icons.arrowDownTray} />`}</button>
			</div>
			${installing && html`<div class="settings-install-status" role="status">Installing skill… this can take a minute.</div>`}
			${installFeedback && html`<div class=${installFeedback.ok ? "settings-ok" : "settings-error"} style="white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto">${installFeedback.text}</div>`}

			<div class="settings-section-title">Installed via skills.sh (${shSkills.length})</div>
			${shSkills.length === 0 && html`<div class="settings-hint">No skills installed via skills.sh yet. Install one above.</div>`}
			${[...shSkills]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(s) => html`
				<div key=${s.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${s.name}</span>
						<span class="settings-item-meta">${s.skillsshSource || ""}</span>
						<${InfoPopover} text=${s.description} readUrl=${`/api/skill-content?name=${encodeURIComponent(s.name)}`} />
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
							if (await confirm(`Uninstall skill "${s.name}" (via npx skills rm)?`))
								act(`/skills-sh uninstall ${s.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
		</div>
	`;
}

function SettingsPlugins({ data, busy, act, confirm }) {
	if (!data) return null;
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Plugins installed on this machine. Each plugin can ship skills, hooks, and MCP servers. To browse and install more, see the <strong>Marketplace</strong> tab.</span></p>
			${[...data.plugins]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(
					(p) => html`
				<div key=${p.id} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-status ${p.enabled ? "ok" : "off"}" />
						<span class="settings-item-name">${p.plugin || p.id}</span>
						<span class="settings-item-meta">${p.marketplace || ""}</span>
						<${InfoPopover} text=${p.description} />
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title=${p.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/plugin ${p.enabled ? "disable" : "enable"} ${p.id}`)}>${p.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
							if (await confirm(`Uninstall plugin "${p.id}"?`)) act(`/plugin uninstall ${p.id}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${data.plugins.length === 0 && html`<div class="settings-hint">No plugins installed. Browse the Marketplace tab to add some.</div>`}
		</div>
	`;
}

function SettingsMarketplace({ data, installed, busy, act, confirm }) {
	const [mpSource, setMpSource] = useState("");
	const [mpQuery, setMpQuery] = useState("");
	const [addStatus, setAddStatus] = useState("");
	// Per-row pending state. The modal's global `busy` flashes for ~100ms then
	// re-enables, leaving no visible feedback that the install actually fired —
	// worse, /plugin install is server-side sync but the reload of `data.plugins`
	// (which gates the "installed" label) used to be skipped, so the button
	// reappeared in its pre-click state and the install looked like a no-op.
	// Tracking pending per id lets us swap the icon for a spinner mid-flight and
	// show a brief "installed ✓" so the action reads as done, not dropped.
	const [pending, setPending] = useState(() => new Set());
	const [justInstalled, setJustInstalled] = useState(null);
	const addPending = (id) =>
		setPending((s) => {
			if (s.has(id)) return s;
			const n = new Set(s);
			n.add(id);
			return n;
		});
	const removePending = (id) =>
		setPending((s) => {
			if (!s.has(id)) return s;
			const n = new Set(s);
			n.delete(id);
			return n;
		});
	useEffect(() => {
		if (!justInstalled) return;
		const t = setTimeout(() => setJustInstalled(null), 2500);
		return () => clearTimeout(t);
	}, [justInstalled]);
	if (!data) return null;
	const catalog = data.catalog || [];
	const sortedCatalog = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
	// `installed` is passed in from the modal's `data.plugins` (separate slice —
	// the Marketplace tab's own `data` only carries catalog + marketplaces). The
	// modal refreshes it after every /plugin command, so a freshly-installed
	// plugin lands in these sets and the row flips from "Install" to "installed".
	const installedNames = new Set((installed || []).map((p) => p.plugin || p.id));
	const installedIds = new Set((installed || []).map((p) => p.id));
	const renderInstallable = (mp, p) => {
		const pkg = p.package || p.name;
		const name = p.name || pkg;
		const id = `${name}@${mp.name}`;
		const installed = installedNames.has(name) || installedIds.has(id);
		const isPending = pending.has(id);
		const showInstalled = installed || justInstalled === id;
		return html`
			<div key=${`${mp.name}:${name}`} class="plugin-catalog-item">
				<div class="plugin-catalog-header">
					<span class="settings-item-name">${name}</span>
					<span class="settings-item-meta">${mp.name}</span>
					${
						isPending
							? html`<span class="settings-inline-loader" role="status" aria-label="Installing ${name}"></span>`
							: showInstalled
								? html`<span class="plugin-installed-label">${justInstalled === id ? "installed ✓" : "installed"}</span>`
								: html`<button class="modal-btn icon-btn" title="Install ${name}" onClick=${async () => {
										addPending(id);
										try {
											const res = await act(`/plugin install ${id}`);
											if (res?.ok) setJustInstalled(id);
										} finally {
											removePending(id);
										}
									}}><${icons.arrowDownTray} /></button>`
					}
				</div>
				${p.description && html`<div class="plugin-catalog-desc">${p.description}</div>`}
			</div>
		`;
	};
	// Every marketplace's plugins merged into one flat list (already loaded
	// in memory — no network round trip) instead of a per-marketplace tab,
	// filtered live by the search box.
	const query = mpQuery.trim().toLowerCase();
	const allPlugins = sortedCatalog
		.filter((mp) => !mp.error)
		.flatMap((mp) =>
			(mp.plugins || [])
				.filter((p) => {
					if (!query) return true;
					const name = (p.name || p.package || "").toLowerCase();
					const desc = (p.description || "").toLowerCase();
					return name.includes(query) || desc.includes(query);
				})
				.map((p) => ({ mp, p })),
		);
	const erroredMarketplaces = sortedCatalog.filter((mp) => mp.error);
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Browse plugin catalogs from configured marketplaces, and manage which marketplaces cast knows about. Plugins you install from here will appear in the <strong>Plugins</strong> tab.</span></p>

			<div class="settings-section-title">Browse marketplaces (${allPlugins.length})</div>
			<div class="settings-form-row">
				<input type="text" placeholder="search all marketplaces (e.g. testing)" value=${mpQuery} onInput=${(e) => setMpQuery(e.target.value)} />
				${
					mpQuery &&
					html`<button class="modal-btn icon-btn" title="Clear search" onClick=${() => setMpQuery("")}><${icons.xMark} /></button>`
				}
			</div>
			${
				catalog.length === 0
					? html`<div class="settings-hint">Loading catalog…</div>`
					: html`
					<div class="plugin-catalog-list">
						${
							allPlugins.length === 0
								? html`<div class="settings-hint">${query ? `No plugins match "${mpQuery}".` : "No plugins found."}</div>`
								: allPlugins
										.sort((a, b) =>
											(a.p.name || a.p.package || "").localeCompare(b.p.name || b.p.package || ""),
										)
										.map(({ mp, p }) => renderInstallable(mp, p))
						}
					</div>
				`
			}
			${
				erroredMarketplaces.length > 0 &&
				html`<div class="settings-hint">Failed to load catalog for: ${erroredMarketplaces.map((mp) => mp.name).join(", ")}.</div>`
			}

			<div class="settings-section-title">Marketplaces</div>
				<div class="settings-rows">
					${[...data.marketplaces]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map(
							(mp) => html`
						<div key=${mp.name} class="settings-item-row">
							<div class="settings-item-info">
								<span class="settings-item-name">${mp.name}</span>
								<span class="settings-item-meta" title=${mp.source}>${mp.isDefault ? "built-in" : shortPath(mp.source)}</span>
							</div>
							<div class="settings-item-actions">
								<button class="modal-btn icon-btn" title="Update" disabled=${busy} onClick=${() => act(`/plugin marketplace update ${mp.name}`)}><${icons.arrowPath} /></button>
								${
									!mp.isDefault &&
									html`<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
										if (await confirm(`Remove marketplace "${mp.name}"?`))
											act(`/plugin marketplace remove ${mp.name}`);
									}}><${icons.trash} /></button>`
								}
							</div>
						</div>
					`,
						)}
					${data.marketplaces.length === 0 && html`<div class="settings-hint">No marketplaces added.</div>`}
					<div class="settings-hint" style="margin-bottom:6px">Any git repo with a <code>marketplace.json</code> catalog works. Add by <code>owner/repo</code>, URL, or path.</div>
					<div class="settings-form-row">
						<input type="text" placeholder="owner/repo, URL, or path" value=${mpSource} onInput=${(e) => {
							setMpSource(e.target.value);
							setAddStatus("");
						}} />
						<button class="modal-btn icon-btn" title="Add marketplace" disabled=${busy || !mpSource} onClick=${async () => {
							const res = await act(`/plugin marketplace add ${mpSource}`);
							if (res.ok) {
								setAddStatus(typeof res.result === "string" ? res.result : "Marketplace added");
								setMpSource("");
							}
						}}><${icons.plus} /></button>
					</div>
					${addStatus && html`<div class="settings-ok" role="status">${addStatus}</div>`}
				</div>
		</div>
	`;
}

function SettingsProvider({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [editing, setEditing] = useState(null);
	const [verifyState, setVerifyState] = useState(null);
	const [saving, setSaving] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const verifyVersion = useRef(0);
	const startEdit = (p) => {
		setEditing(p.name);
		setName(p.name);
		setUrl(p.url);
		setApiKey(p.apiKey);
		setVerifyState(p.url && p.apiKey ? { ok: true, msg: "Saved — re-verify to confirm changes" } : null);
	};
	const cancelEdit = () => {
		setEditing(null);
		setName("");
		setUrl("");
		setApiKey("");
		setVerifyState(null);
	};
	// Probe the entered URL + key without saving. Rejects outright when either
	// field is empty so the button can't fire a pointless round trip.
	const doVerify = async () => {
		if (!url || !apiKey) {
			setVerifyState({ ok: false, msg: "Enter a base URL and API key first" });
			return;
		}
		const version = ++verifyVersion.current;
		setVerifying(true);
		setVerifyState({ ok: null, msg: "Verifying…" });
		try {
			const res = await api("POST", "/api/provider/verify", { url, apiKey });
			if (version !== verifyVersion.current) return;
			if (res?.ok) setVerifyState({ ok: true, msg: "Provider reachable" });
			else setVerifyState({ ok: false, msg: res?.error || "Verification failed" });
		} catch (_e) {
			if (version === verifyVersion.current) setVerifyState({ ok: false, msg: "Verification request failed" });
		} finally {
			if (version === verifyVersion.current) setVerifying(false);
		}
	};
	// Mandatory gate: a provider is never saved with unverified credentials.
	const saveProvider = async () => {
		if (!name || !url || !apiKey) return;
		setSaving(true);
		try {
			const res = await api("POST", "/api/provider/verify", { url, apiKey });
			if (!res?.ok) {
				setVerifyState({ ok: false, msg: res?.error || "Verification failed — provider not saved" });
				return;
			}
			if (editing) {
				await act(`/provider delete ${editing}`);
				await act(`/provider add ${name} ${url} ${apiKey}`);
				if (data.find((p) => p.active && p.name === editing)) await act(`/provider ${name}`);
			} else {
				await act(`/provider add ${name} ${url} ${apiKey}`);
			}
			cancelEdit();
		} finally {
			setSaving(false);
		}
	};
	return html`
		<div class="settings-rows">
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(p) => html`
				<div key=${p.name} class="settings-item-row${p.active ? " active" : ""}">
					<div class="settings-item-info">
						<span class="settings-item-status${p.active ? " ok" : ""}" title=${p.active ? "Active provider" : "Not active"}></span>
						<span class="settings-item-name">${p.name}${p.active ? html` <span class="settings-item-tag">active</span>` : null}</span>
						<span class="settings-item-meta" title=${p.url}>${shortPath(p.url)}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title="Edit" disabled=${busy} onClick=${() => startEdit(p)}><${icons.pencil} /></button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Delete" disabled=${busy} onClick=${async () => {
							if (await confirm(`Delete provider "${p.name}"?`)) act(`/provider delete ${p.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${!data || data.length === 0 ? html`<div class="settings-hint">No saved providers.</div>` : null}
			${data && data.length > 0 ? html`<div class="settings-hint">Providers here are just a saved list. In the Model tab, pick which provider each model slot uses (main / subagent / plan) — they can be on different providers.</div>` : null}
			<div class="settings-section-title">${editing ? `Edit provider: ${editing}` : "Add provider"}</div>
			<div class="settings-form-row">
				<form style="display:contents" onSubmit=${(e) => e.preventDefault()}>
				<input type="text" placeholder="name" value=${name} disabled=${!!editing} onInput=${(e) => {
					setName(e.target.value);
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<input type="text" placeholder="base URL" value=${url} onInput=${(e) => {
					setUrl(e.target.value);
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<input type="password" autocomplete="off" placeholder="API key" value=${apiKey} onInput=${(e) => {
					setApiKey(e.target.value);
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<button class="modal-btn icon-btn" title="Verify credentials" disabled=${busy || saving || verifying || !url || !apiKey} onClick=${doVerify}><${icons.arrowPath} /></button>
				<button class="modal-btn icon-btn" title=${editing ? "Save changes" : "Add provider"} disabled=${busy || saving || verifying || !name || !url || !apiKey} onClick=${saveProvider}><${icons.check} /></button>
				${editing ? html`<button class="modal-btn icon-btn" title="Cancel" disabled=${busy || saving} onClick=${cancelEdit}><${icons.xCircle} /></button>` : null}
				</form>
			</div>
			${verifyState ? html`<div class="settings-hint ${verifyState.ok === false ? "settings-error" : verifyState.ok === true ? "settings-ok" : ""}">${verifyState.ok === false ? "✕ " : verifyState.ok === true ? "✓ " : ""}${verifyState.msg}</div>` : null}
			<div class="settings-hint">Credentials are verified before saving — the provider must be reachable.</div>
		</div>
	`;
}

function SettingsSsh({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [port, setPort] = useState("");
	const [authMode, setAuthMode] = useState("agent");
	const [password, setPassword] = useState("");
	const [keyContent, setKeyContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [formStatus, setFormStatus] = useState(null);
	const addHost = async () => {
		const parsedPort = port ? Number(port) : undefined;
		if (port && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
			setFormStatus({ ok: false, message: "Port must be a number from 1 to 65535" });
			return;
		}
		if (authMode === "key" && !keyContent.trim()) {
			setFormStatus({ ok: false, message: "Paste a private key or choose SSH agent" });
			return;
		}
		if (authMode === "password" && !password) {
			setFormStatus({ ok: false, message: "Enter a password or choose another sign-in method" });
			return;
		}
		setSaving(true);
		setFormStatus(null);
		try {
			let keyPath;
			if (authMode === "key") {
				const keyResult = await api("POST", "/api/ssh/key", { name, key: keyContent.trim() });
				if (!keyResult?.ok) {
					setFormStatus({ ok: false, message: keyResult?.error || "Could not save the private key" });
					return;
				}
				keyPath = keyResult.path;
			}
			const result = await api("POST", "/api/ssh/add", {
				name,
				host,
				username: username || undefined,
				port: parsedPort,
				keyPath,
				password: authMode === "password" ? password : undefined,
			});
			if (!result?.ok) {
				setFormStatus({ ok: false, message: result?.error || "Could not add the host" });
				return;
			}
			setName("");
			setHost("");
			setUsername("");
			setPort("");
			setAuthMode("agent");
			setPassword("");
			setKeyContent("");
			setFormStatus({ ok: true, message: `Added ${name}` });
			await act("/ssh list");
		} catch (err) {
			setFormStatus({ ok: false, message: err instanceof Error ? err.message : "Could not add the host" });
		} finally {
			setSaving(false);
		}
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Remote machines the agent can run commands on via the <code>ssh</code> tool — deploy code, inspect logs, and more.</span></p>
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(h) => html`
				<div key=${h.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${h.name}</span>
						<span class="settings-item-meta">${h.username ? `${h.username}@` : ""}${h.host}${h.port ? `:${h.port}` : ""} · ${h.keyPath ? "private key" : h.password ? "password" : "SSH agent"}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
							if (await confirm(`Remove host "${h.name}"?`)) act(`/ssh remove ${h.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${(!data || data.length === 0) && html`<div class="settings-hint">No SSH hosts configured.</div>`}
			<div class="settings-section-title">Add host</div>
			<div class="settings-ssh-form">
				<div class="settings-form-row">
					<input type="text" placeholder="Name (e.g. production)" value=${name} disabled=${saving} onInput=${(e) => setName(e.target.value)} />
					<input type="text" placeholder="Host or IP" value=${host} disabled=${saving} onInput=${(e) => setHost(e.target.value)} />
				</div>
				<div class="settings-form-row">
					<input type="text" autocomplete="username" placeholder="Username (optional)" value=${username} disabled=${saving} onInput=${(e) => setUsername(e.target.value)} />
					<input type="text" inputMode="numeric" placeholder="Port (22)" value=${port} disabled=${saving} onInput=${(e) => setPort(e.target.value)} />
				</div>
				<div class="settings-row-label">Sign in with</div>
				<div class="settings-form-row">
					<button class="modal-btn${authMode === "agent" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("agent")}>SSH agent</button>
					<button class="modal-btn${authMode === "key" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("key")}>Private key</button>
					<button class="modal-btn${authMode === "password" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("password")}>Password</button>
				</div>
				${authMode === "agent" ? html`<div class="settings-hint">Uses your system SSH configuration and agent. No credential is stored by cast.</div>` : null}
				${authMode === "key" ? html`<textarea class="settings-textarea" autocomplete="off" placeholder="Paste private key" value=${keyContent} disabled=${saving} onInput=${(e) => setKeyContent(e.target.value)} rows="4" />` : null}
				${
					authMode === "password"
						? html`<div class="settings-form-row"><form style="display:contents" onSubmit=${(e) => e.preventDefault()}><input type="password" autocomplete="off" placeholder="Password (requires sshpass on this machine)" value=${password} disabled=${saving} onInput=${(e) => setPassword(e.target.value)} /></form></div>`
						: null
				}
				${formStatus ? html`<div class="settings-hint ${formStatus.ok ? "settings-ok" : "settings-error"}" role="status">${formStatus.message}</div>` : null}
				<div class="settings-form-row" style=${{ justifyContent: "flex-end" }}>
					<button class="modal-btn modal-btn-primary" disabled=${busy || saving || !name || !host} onClick=${addHost}>${saving ? "Adding…" : "Add host"}</button>
				</div>
			</div>
		</div>
	`;
}

function InfoPopover({ text, readUrl, contentLabel = "Skill content" }) {
	const [infoOpen, setInfoOpen] = useState(false);
	const [bookOpen, setBookOpen] = useState(false);
	const [fullContent, setFullContent] = useState(null);
	// Same anti-flicker discipline as FilePreviewModal: stays null (renders
	// "Loading…") through marked's async load+parse instead of flashing the
	// raw markdown source first — see that component's comment for why.
	const [renderedHtml, setRenderedHtml] = useState(null);
	const [renderFailed, setRenderFailed] = useState(false);
	useEffect(() => {
		if (!infoOpen) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setInfoOpen(false);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [infoOpen]);
	useEffect(() => {
		if (!bookOpen) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setBookOpen(false);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [bookOpen]);
	const modalRef = useModalFocusTrap(bookOpen);
	const loadFull = async () => {
		setBookOpen(true);
		setFullContent(null);
		setRenderedHtml(null);
		setRenderFailed(false);
		let content;
		try {
			const res = await api("GET", readUrl);
			content = res?.content || res?.error || "No content";
		} catch {
			content = "Failed to load";
		}
		setFullContent(content);
		try {
			const { marked } = await loadMarked();
			setRenderedHtml(marked.parse(content));
		} catch {
			setRenderFailed(true);
		}
	};
	if (!text && !readUrl) return null;
	return [
		html`<span class="info-popover-wrap" style=${{ display: "inline-flex", gap: "2px" }}>
			${
				text
					? html`<button class="modal-btn icon-btn" title="Description" onClick=${(e) => {
							e.stopPropagation();
							setInfoOpen(true);
						}}><${icons.info} /></button>`
					: null
			}
			${
				readUrl
					? html`<button class="modal-btn icon-btn" title="Read full content" onClick=${(e) => {
							e.stopPropagation();
							loadFull();
						}}><${icons.bookOpen} /></button>`
					: null
			}
		</span>`,
		infoOpen && html`<div class="info-popover-backdrop" onClick=${() => setInfoOpen(false)} />`,
		infoOpen &&
			html`<div class="info-popover" onClick=${(e) => e.stopPropagation()}>
			<div class="info-popover-header"><button class="modal-btn icon-btn" onClick=${() => setInfoOpen(false)}><${icons.xMark} /></button></div>
			<div class="info-popover-text">${text}</div>
		</div>`,
		bookOpen &&
			html`<div class="modal-backdrop" onClick=${() => setBookOpen(false)}>
			<div class="modal modal-preview" role="dialog" aria-modal="true" aria-label=${contentLabel} tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>${contentLabel}</span>
					<button class="modal-close" onClick=${() => setBookOpen(false)} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="fs-preview-body">
					${
						fullContent == null || (renderedHtml == null && !renderFailed)
							? html`<div class="diff-empty">Loading…</div>`
							: renderFailed
								? html`<pre class="fs-preview-text">${fullContent}</pre>`
								: html`<div class="fs-preview-markdown message-content" dangerouslySetInnerHTML=${{ __html: renderedHtml }} />`
					}
				</div>
			</div>
		</div>`,
	];
}

function SettingsDefaultUi() {
	const [uis, setUis] = useState([]);
	const [selected, setSelected] = useState("default");
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState(null);
	useEffect(() => {
		api("GET", "/api/uis").then((d) => Array.isArray(d) && setUis(d)).catch(()=>{});
		api("GET", "/api/settings/default-ui").then((d) => d?.defaultUi && setSelected(d.defaultUi)).catch(()=>{});
	}, []);
	const save = async () => {
		setSaving(true);
		setStatus(null);
		try {
			const res = await api("POST", "/api/settings/default-ui", { name: selected });
			if (res?.ok) setStatus({ ok: true, text: `Default UI set to ${selected} — open / to see` });
			else setStatus({ ok: false, text: res?.error || "Failed" });
		} catch (e) {
			setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
		} finally {
			setSaving(false);
		}
	};
	const current = uis.find((u) => u.name === selected)?.name ?? selected;
	return html`<div class="settings-rows">
		<p class="settings-intro"><span>Choose which UI opens at <code>/</code> — like default assistant. Factory UIs at <code>/ui/&lt;name&gt;/</code> and <code>/&lt;name&gt;/</code> stay always reachable.</span></p>
		<div class="settings-form-row">
			<select value=${selected} onChange=${(e) => setSelected(e.target.value)} disabled=${saving}>
				<option value="default">default — built-in Cast</option>
				${uis.filter((u) => !u.builtin).map((u) => html`<option value=${u.name}>${u.name}</option>`)}
			</select>
			<button class="modal-btn icon-btn" title="Save" disabled=${saving} onClick=${save}>${saving ? html`<span class="settings-inline-loader" />` : html`<${icons.check} />`}</button>
		</div>
		${status ? html`<div class=${status.ok ? "settings-ok" : "settings-error"}>${status.text}</div>` : null}
	</div>`;
}

function SettingsUpdates() {
	const [info, setInfo] = useState(null);
	const [checking, setChecking] = useState(true);
	const [upgrading, setUpgrading] = useState(false);
	const [error, setError] = useState(null);

	const check = useCallback(async () => {
		setChecking(true);
		setError(null);
		try {
			// quick check — 3s timeout on server, plus client abort
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 4000);
			const res = await fetch("/api/system/version", { cache: "no-store", signal: controller.signal });
			clearTimeout(timer);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			setInfo(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => { check(); }, [check]);

	const doUpgrade = async () => {
		setUpgrading(true);
		setError(null);
		try {
			const res = await api("POST", "/api/system/upgrade", {});
			if (res?.queued) {
				setError(null);
				// poll for new version after upgrade queued
				setTimeout(check, 5000);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setUpgrading(false);
		}
	};

	if (checking && !info) {
		return html`<div class="settings-rows"><div class="settings-loading"><span class="settings-inline-loader" /> Checking for updates…</div></div>`;
	}

	return html`<div class="settings-rows">
		<p class="settings-intro"><span>Keep Cast up to date. Checks GitHub releases quickly on open (3s timeout) — no hang.</span></p>
		<div class="settings-compact-list">
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Current</span><span><code>v${info?.current ?? "—"}</code> ${info?.isRelease ? "" : "(dev — git pull)"}</span></div>
			</div>
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Latest</span><span>${info?.latest ? html`<code>v${info.latest}</code>` : "—"} ${info?.isRelease && info?.updateAvailable ? html`<span class="settings-item-tag">update available</span>` : ""}</span></div>
				<button class="modal-btn" disabled=${checking} onClick=${check} title="Check again">${checking ? html`<span class="settings-inline-loader" />` : "Check"}</button>
			</div>
		</div>
		${error ? html`<div class="settings-error" style="white-space:pre-wrap">${error}</div>` : null}
		${info?.isRelease && info?.updateAvailable
			? html`<div class="settings-section-title">Update</div>
				<p class="settings-hint">A newer version v${info.latest} is available. Upgrade runs <code>install.sh</code> and restarts the daemon on the same <code>host:port</code> — web UI will show <em>reconnecting</em> for ~3s.</p>
				<button class="modal-btn modal-btn-primary" disabled=${upgrading} onClick=${doUpgrade}>${upgrading ? html`<span class="settings-inline-loader" /> Updating…` : `Update to v${info.latest}`}</button>`
			: info && !checking
				? html`<div class="settings-ok" style="margin-top:8px">Up to date${info.isRelease ? "" : " (dev — git pull to update)"}.</div>`
				: null}
		${!info?.isRelease ? html`<p class="settings-hint" style="margin-top:8px">Running from source — upgrade via <code>git pull</code>, not this button.</p>` : null}
	</div>`;
}

export {
	InfoPopover,
	SettingsBash,
	SettingsDefaultUi,
	SettingsHooks,
	SettingsMemory,
	SettingsMcp,
	SettingsMarketplace,
	SettingsPlugins,
	SettingsProvider,
	SettingsPersonas,
	SettingsQuickMode,
	SettingsServer,
	SettingsSkills,
	SettingsUpdates,
	SettingsSkillssh,
	SettingsSsh,
	SettingsWeb,
};
