import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";

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

export function PlanDecisionCard({ transition, onChoose }) {
	if (!transition) return null;
	return html`
		<section class="plan-decision-card plan-review-card" aria-label="Plan review">
			<div class="plan-decision-header"><span class="plan-decision-name">plan</span><span class="plan-decision-kind">review</span></div>
			<div class="plan-decision-body">Plan ready. What next?</div>
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
										(option) => html`<button class="plan-decision-option ${answers[index]?.includes(option.value) ? "selected" : ""}" onClick=${() => toggleMulti(index, option.value)}>
											<span class="plan-decision-option-label">${option.label}${option.value === item.recommended ? " (recommended)" : ""}</span>
											${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
										</button>`,
									)
								: item.options.map(
										(option) => html`<button class="plan-decision-option ${answers[index] === option.value ? "selected" : ""}" onClick=${() => setAnswers((prev) => prev.map((value, i) => (i === index ? option.value : value)))}>
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
