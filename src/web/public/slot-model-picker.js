import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

export function SlotModelPicker({
	busy,
	act,
	providers,
	activeProviderName,
	currentProvider,
	currentModel,
	fallbackModel,
	providerCommand,
	modelCommand,
	isMainSlot,
	initialModels,
}) {
	const initialProvider = currentProvider || "";
	const effectiveModel = currentModel || "";
	const [providerValue, setProviderValue] = useState(initialProvider);
	const [modelValue, setModelValue] = useState(effectiveModel);
	const [models, setModels] = useState(initialModels || []);
	const [loading, setLoading] = useState(false);
	const modelRequestVersion = useRef(0);
	const defaultLabel = isMainSlot
		? activeProviderName || "Select…"
		: activeProviderName
			? `${activeProviderName} (same as main)`
			: "Same as main";

	useEffect(() => {
		let cancelled = false;
		const version = ++modelRequestVersion.current;
		(async () => {
			setLoading(true);
			const effectiveProvider = initialProvider || activeProviderName || "";
			const qs = effectiveProvider ? `?provider=${encodeURIComponent(effectiveProvider)}` : "";
			try {
				const res = await api("GET", `/api/models${qs}`);
				if (!cancelled && version === modelRequestVersion.current) setModels(res?.models ?? []);
			} catch {
				if (!cancelled && version === modelRequestVersion.current) setModels([]);
			}
			if (!cancelled && version === modelRequestVersion.current) setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [initialProvider, activeProviderName]);

	const onProviderChange = useCallback(async (name) => {
		const version = ++modelRequestVersion.current;
		setProviderValue(name);
		setModelValue("");
		setLoading(true);
		try {
			const qs = name ? `?provider=${encodeURIComponent(name)}` : "";
			const res = await api("GET", `/api/models${qs}`);
			if (version === modelRequestVersion.current) setModels(res?.models ?? []);
		} catch {
			if (version === modelRequestVersion.current) setModels([]);
		}
		if (version === modelRequestVersion.current) setLoading(false);
	}, []);
	const doSet = useCallback(async () => {
		if (providerValue) await act(`${providerCommand} ${providerValue}`);
		if (modelValue && models.some((model) => model.id === modelValue)) await act(`${modelCommand} ${modelValue}`);
	}, [providerValue, modelValue, models, act, providerCommand, modelCommand]);
	const doReset = useCallback(async () => {
		await act(`${modelCommand} reset`);
		setProviderValue("");
		setModelValue("");
		setModels([]);
	}, [act, modelCommand]);
	const hasOverride = currentProvider || currentModel;
	return html`<div class="settings-form-row">
		<select disabled=${busy} value=${providerValue} onChange=${(event) => onProviderChange(event.target.value)}><option value="">${defaultLabel}</option>${providers.map((provider) => html`<option key=${provider.name} value=${provider.name}>${provider.name}</option>`)}</select>
		<select disabled=${busy || (loading && models.length === 0)} onChange=${(event) => setModelValue(event.target.value)} value=${modelValue && models.some((model) => model.id === modelValue) ? modelValue : ""}>
			<option value="">${loading && models.length === 0 ? "Loading…" : `Pick a model…${fallbackModel && models.some((model) => model.id === fallbackModel) ? ` (inherits ${fallbackModel})` : ""}`}</option>
			${[...models].sort((a, b) => a.id.localeCompare(b.id)).map((model) => html`<option key=${model.id} value=${model.id}>${model.id}${model.reasoning ? " (reasoning)" : ""}</option>`)}
		</select>
		<button class="modal-btn icon-btn" title="Apply" disabled=${busy || !modelValue || !models.some((model) => model.id === modelValue) || (providerValue === initialProvider && modelValue === effectiveModel)} onClick=${doSet}><${icons.check} /></button>
		${!isMainSlot && hasOverride ? html`<button class="modal-btn icon-btn" title="Use the main model and provider" disabled=${busy} onClick=${doReset}><${icons.arrowUturnLeft} /></button>` : null}
	</div>`;
}
