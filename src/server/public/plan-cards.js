import htm from "htm";
import { h } from "preact";
import { useMemo, useState } from "preact/hooks";
import { lazy } from "./lazy.js";
import { elicitContent, elicitErrors, elicitFields, elicitInitialValues } from "./mcp-elicit.js";

const TRAILING_SLASH_RE = /\/$/;
const FilePreviewModal = lazy(() => import("./file-preview.js"), (m) => m.FilePreviewModal);

const html = htm.bind(h);

export const PLAN_DECISION_OPTIONS = [
	{ value: "continue", label: "Continue planning", description: "Keep refining the plan with feedback." },
	{ value: "implement", label: "Approve and implement", description: "Switch to build and execute this plan now." },
	{
		value: "clean",
		label: "Approve and implement in clean context",
		description: "Keep this thread visible, but start implementation without its prior model context.",
	},
];

// The plan the agent just finished is what the person is asked to approve, so the card has to show it. It is in the
// result of the last plan_done call: its summary, and the file the full plan was written to (shown only when that
// file is inside the project, since that is all the file API serves).
export function latestPlan(messages, cwd) {
	for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
		const calls = messages[i]?.toolCalls;
		for (let j = (calls?.length ?? 0) - 1; j >= 0; j--) {
			if (calls[j].name !== "plan_done" || !calls[j].result) continue;
			try {
				const { name, summary, path } = JSON.parse(calls[j].result);
				const prefix = cwd ? `${cwd.replace(TRAILING_SLASH_RE, "")}/` : null;
				return { name, summary, relPath: prefix && typeof path === "string" && path.startsWith(prefix) ? path.slice(prefix.length) : null };
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function PlanDecisionCard({ transition, onChoose, plan, sessionId }) {
	const [reading, setReading] = useState(false);
	if (!transition) return null;
	const href = plan?.relPath ? `/api/sessions/${sessionId}/fs/download?path=${encodeURIComponent(plan.relPath)}` : null;
	return html`
		<section class="plan-decision-card plan-review-card" aria-label="Plan review">
			<div class="plan-decision-header"><span class="plan-decision-name">plan</span><span class="plan-decision-kind">review</span></div>
			<div class="plan-decision-body">${plan?.summary ? plan.summary : "Plan ready. What next?"}</div>
			${href && html`<button type="button" class="plan-decision-option plan-read" onClick=${() => setReading(true)}><span class="plan-decision-option-label">Read the plan</span><span class="plan-decision-option-description">${plan.relPath}</span></button>`}
			${reading && html`<${FilePreviewModal} path=${plan.relPath} onClose=${() => setReading(false)} downloadHref=${href} previewHref=${`${href}&inline=1`} />`}
			<div class="plan-decision-options">
				${PLAN_DECISION_OPTIONS.map(
					(option) => html`<button class="plan-decision-option" onClick=${() => onChoose(option.value)}>
						<span class="plan-decision-option-label">${option.label}${option.recommended ? " (recommended)" : ""}</span>
						${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
					</button>`,
				)}
			</div>
		</section>
	`;
}

export function QuestionCard({ question, onChoose }) {
	const items = question?.questions ?? [];
	// `answers[i]` is the canonical value for question i. A single-choice
	// question holds one selected option value (or typed text); a multi-select
	// question holds an array of the checked option values.
	const [answers, setAnswers] = useState(() => items.map((item) => (item.multi ? [] : "")));
	if (items.length === 0) return null;
	const complete = answers.every((value) =>
		Array.isArray(value) ? value.length > 0 : value && value.trim() !== "",
	);
	const toggleMulti = (index, optionValue) =>
		setAnswers((prev) =>
			prev.map((value, i) => {
				if (i !== index || !Array.isArray(value)) return value;
				return value.includes(optionValue)
					? value.filter((v) => v !== optionValue)
					: [...value, optionValue];
			}),
		);
	return html`
		<section class="plan-decision-card question-card" aria-label="Questions from agent">
			<div class="plan-decision-header"><span class="plan-decision-name">agent</span><span class="plan-decision-kind">questions</span></div>
			${items.map(
				(item, index) => html`
					<div class="plan-decision-body">${item.question}</div>
					<div class="plan-decision-options">
						${
							item.multi
								? item.options.map(
										(option) => html`<button aria-pressed=${Boolean(answers[index]?.includes(option.value))} class="plan-decision-option ${answers[index]?.includes(option.value) ? "selected" : ""}" onClick=${() => toggleMulti(index, option.value)}>
											<span class="plan-decision-option-label">${option.label}${option.value === item.recommended ? " (recommended)" : ""}</span>
											${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
										</button>`,
									)
								: item.options.map(
										(option) => html`<button aria-pressed=${Boolean(answers[index] === option.value)} class="plan-decision-option ${answers[index] === option.value ? "selected" : ""}" onClick=${() => setAnswers((prev) => prev.map((value, i) => (i === index ? option.value : value)))}>
											<span class="plan-decision-option-label">${option.label}${option.value === item.recommended ? " (recommended)" : ""}</span>
											${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
										</button>`,
									)
						}
						${
							!item.multi &&
							!item.noFreeForm &&
							html`<textarea
								class="plan-decision-option plan-decision-textarea"
								value=${answers[index]}
								aria-label="Your own answer"
								placeholder="Or your own answer…"
								rows="2"
								onInput=${(e) => setAnswers((prev) => prev.map((value, i) => (i === index ? e.currentTarget.value : value)))}
							></textarea>`
						}
					</div>
				`,
			)}
			<div class="plan-decision-options"><button class="plan-decision-option" disabled=${!complete} onClick=${() => onChoose(answers)}>Continue</button></div>
		</section>
	`;
}

/**
 * The daemon runs the agent loop, so its dangerous-command gate has no picker
 * of its own — it asks whoever is watching. The turn is blocked until this is
 * answered (or the daemon times the request out and denies it).
 */
export function BashConfirmCard({ request, onAnswer }) {
	if (!request) return null;
	return html`
		<section class="plan-decision-card question-card" aria-label="Confirm a tool call">
			<div class="plan-decision-header">
				<span class="plan-decision-name">approval</span>
				<span class="plan-decision-kind">${request.reason}</span>
			</div>
			<div class="plan-decision-body"><code>${request.command}</code></div>
			<div class="plan-decision-options">
				<button class="plan-decision-option" onClick=${() => onAnswer(request.id, true)}>
					<span class="plan-decision-option-label">Allow once</span>
				</button>
				<button class="plan-decision-option" title=${`Saves ${request.rule ?? `bash(${request.command})`} to your permission rules`} onClick=${() => onAnswer(request.id, true, true)}>
					<span class="plan-decision-option-label">Always allow</span>
				</button>
				<button class="plan-decision-option" onClick=${() => onAnswer(request.id, false)}>
					<span class="plan-decision-option-label">Block</span>
				</button>
			</div>
		</section>
	`;
}

const INPUT_TYPES = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" };

/** A form an MCP server asked the person to fill in while one of its tools runs. */
export function McpElicitCard({ request, onAnswer }) {
	const fields = useMemo(() => elicitFields(request?.schema), [request?.schema]);
	const [values, setValues] = useState(() => elicitInitialValues(fields));
	const [tried, setTried] = useState(false);
	const [sent, setSent] = useState(false);
	if (!request) return null;
	const errors = elicitErrors(fields, values);
	const set = (name, value) => setValues((prev) => ({ ...prev, [name]: value }));
	const answer = (action) => {
		if (action === "accept") {
			setTried(true);
			if (Object.keys(errors).length > 0) return;
		}
		setSent(true);
		onAnswer(request.id, action, action === "accept" ? elicitContent(fields, values) : undefined);
	};
	const shown = (f) => (tried ? errors[f.name] : undefined);
	const control = (f) => {
		const id = `elicit-${request.id}-${f.name}`;
		const common = { id, disabled: sent, "aria-invalid": shown(f) ? "true" : undefined, "aria-describedby": `${id}-note` };
		if (f.kind === "boolean") {
			return html`<label class="elicit-check"><input type="checkbox" ...${common} checked=${values[f.name]} onChange=${(e) => set(f.name, e.currentTarget.checked)} /> ${f.label}</label>`;
		}
		if (f.kind === "multi") {
			return html`<div class="elicit-group" role="group" aria-labelledby=${`${id}-label`}>${f.options.map(
				(o) => html`<label class="elicit-check"><input type="checkbox" disabled=${sent} checked=${values[f.name].includes(o.value)} onChange=${(e) =>
					set(f.name, e.currentTarget.checked ? [...values[f.name], o.value] : values[f.name].filter((x) => x !== o.value))} /> ${o.label}</label>`,
			)}</div>`;
		}
		if (f.kind === "select" && f.options.length <= 4) {
			return html`<div class="elicit-group" role="radiogroup" aria-labelledby=${`${id}-label`}>${f.options.map(
				(o) => html`<label class="elicit-check"><input type="radio" name=${id} disabled=${sent} checked=${values[f.name] === o.value} onChange=${() => set(f.name, o.value)} /> ${o.label}</label>`,
			)}</div>`;
		}
		if (f.kind === "select") {
			return html`<select class="elicit-input" ...${common} value=${values[f.name]} onChange=${(e) => set(f.name, e.currentTarget.value)}>
				<option value="">Choose...</option>
				${f.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
			</select>`;
		}
		const numeric = f.kind === "number" || f.kind === "integer";
		return html`<input class="elicit-input" ...${common} type=${numeric ? "number" : (INPUT_TYPES[f.format] ?? "text")}
			step=${f.kind === "integer" ? "1" : numeric ? "any" : undefined} min=${f.min} max=${f.max} minlength=${f.minLength} maxlength=${f.maxLength}
			value=${values[f.name]} onInput=${(e) => set(f.name, e.currentTarget.value)} />`;
	};
	return html`
		<section class="plan-decision-card question-card elicit-card" aria-label=${`Input requested by ${request.server}`}>
			<div class="plan-decision-header">
				<span class="plan-decision-name">${request.server}</span>
				<span class="plan-decision-kind">asks for input</span>
			</div>
			<form class="plan-decision-body elicit-form" noValidate onSubmit=${(e) => { e.preventDefault(); answer("accept"); }}>
				<p class="elicit-message">${request.message}</p>
				${fields.map(
					(f) => html`<div class="elicit-field" key=${f.name}>
						${f.kind !== "boolean" && html`<label class="elicit-label" id=${`elicit-${request.id}-${f.name}-label`} for=${`elicit-${request.id}-${f.name}`}>${f.label}${f.required ? " *" : ""}</label>`}
						${control(f)}
						<span class="elicit-note${shown(f) ? " error" : ""}" id=${`elicit-${request.id}-${f.name}-note`} role=${shown(f) ? "alert" : undefined}>${shown(f) ?? f.description ?? ""}</span>
					</div>`,
				)}
				<div class="elicit-actions">
					<button type="submit" class="plan-decision-option" disabled=${sent}><span class="plan-decision-option-label">Submit</span></button>
					<button type="button" class="plan-decision-option" disabled=${sent} onClick=${() => answer("decline")}><span class="plan-decision-option-label">Decline</span></button>
					<button type="button" class="plan-decision-option" disabled=${sent} onClick=${() => answer("cancel")}><span class="plan-decision-option-label">Cancel</span></button>
				</div>
			</form>
		</section>
	`;
}
