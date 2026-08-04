import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { icons } from "./icons.js";
import { SlotModelPicker } from "./slot-model-picker.js";

const html = htm.bind(h);

export function SettingsModel({ data, busy, act }) {
	const [pendingValue, setPendingValue] = useState("");
	if (!data) return null;
	const current = data.current || {};
	const providers = data.providers || [];
	const activeProviderName = providers.find((provider) => provider.active)?.name ?? "";
	const currentLevel = current.reasoningLevel ?? "";
	// The select shows the current level by default; the ✓ button only
	// lights up when the user picks something different from the saved
	// level (so picking the same value is a no-op, and after a successful
	// apply the button returns to its gray state without the select
	// jumping back to the placeholder).
	const isPending = !!pendingValue && pendingValue !== currentLevel;
	const applyReasoning = async () => {
		if (!isPending) return;
		const res = await act(`/reasoning ${pendingValue}`);
		if (res?.ok) setPendingValue("");
	};
	return html`<div class="settings-rows">
		<div class="settings-section-title">Model</div>
		<p class="settings-hint">Pick a provider first — its dropdown populates with that provider's models. Pick a model and click Apply.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${activeProviderName} currentModel=${current.model} providerCommand="/provider" modelCommand="/model" isMainSlot=${true} initialModels=${data.models} />
		<div class="settings-section-title">Reasoning — current: ${currentLevel || "off"}</div>
		${data.reasoningOptions.length === 0 ? html`<div class="settings-hint">This model exposes no reasoning controls.</div>` : html`<p class="settings-hint">Controls how much internal thinking the model does before answering. Higher levels use more tokens but can improve complex task performance.</p><div class="settings-form-row"><select value=${pendingValue || currentLevel} onChange=${(event) => setPendingValue(event.target.value)}><option value="">Pick a level…</option>${data.reasoningOptions.map((option) => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}</select><button class="modal-btn icon-btn" title="Apply reasoning" disabled=${busy || !isPending} onClick=${applyReasoning}><${icons.check} /></button></div>`}
		<div class="settings-section-title">Subagent model</div>
		<p class="settings-hint">Model used for task subagents — inherits the main model unless overridden here. Use ↩ to return to inheritance.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${current.subagentModelProvider} currentModel=${current.subagentModel} fallbackModel=${current.model} providerCommand="/subagent-model-provider" modelCommand="/subagent-model" initialModels=${data.models} />
		<div class="settings-section-title">Plan-mode model</div>
		<p class="settings-hint">Model used when the agent enters plan mode — inherits the main model unless overridden here.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${current.planModelProvider} currentModel=${current.planModel} fallbackModel=${current.model} providerCommand="/plan-model-provider" modelCommand="/plan-model" initialModels=${data.models} />
	</div>`;
}
