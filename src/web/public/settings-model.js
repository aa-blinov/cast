import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { icons } from "./icons.js";
import { SlotModelPicker } from "./slot-model-picker.js";

const html = htm.bind(h);

export function SettingsModel({ data, busy, act }) {
	const [reasoningValue, setReasoningValue] = useState("");
	if (!data) return null;
	const current = data.current || {};
	const providers = data.providers || [];
	const activeProviderName = providers.find((provider) => provider.active)?.name ?? "";
	return html`<div class="settings-rows">
		<div class="settings-section-title">Model</div>
		<p class="settings-hint">Pick a provider first — its dropdown populates with that provider's models. Pick a model and click Apply.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${activeProviderName} currentModel=${current.model} providerCommand="/provider" modelCommand="/model" isMainSlot=${true} initialModels=${data.models} />
		<div class="settings-section-title">Reasoning — current: ${current.reasoningLevel ?? "off"}</div>
		${data.reasoningOptions.length === 0 ? html`<div class="settings-hint">This model exposes no reasoning controls.</div>` : html`<p class="settings-hint">Controls how much internal thinking the model does before answering. Higher levels use more tokens but can improve complex task performance.</p><div class="settings-form-row"><select onChange=${(event) => setReasoningValue(event.target.value)}><option value="">Pick a level…</option>${data.reasoningOptions.map((option) => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}</select><button class="modal-btn icon-btn" title="Apply reasoning" disabled=${busy || !reasoningValue} onClick=${() => act(`/reasoning ${reasoningValue}`)}><${icons.check} /></button></div>`}
		<div class="settings-section-title">Subagent model${current.subagentModelProvider ? ` — @ ${current.subagentModelProvider}` : ""}</div>
		<p class="settings-hint">Model used for task subagents — inherits the main model unless overridden here. Use ↩ to return to inheritance.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${current.subagentModelProvider} currentModel=${current.subagentModel} fallbackModel=${current.model} providerCommand="/subagent-model-provider" modelCommand="/subagent-model" initialModels=${data.models} />
		<div class="settings-section-title">Plan-mode model${current.planModelProvider ? ` — @ ${current.planModelProvider}` : ""}</div>
		<p class="settings-hint">Model used when the agent enters plan mode — inherits the main model unless overridden here.</p>
		<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${current.planModelProvider} currentModel=${current.planModel} fallbackModel=${current.model} providerCommand="/plan-model-provider" modelCommand="/plan-model" initialModels=${data.models} />
	</div>`;
}
