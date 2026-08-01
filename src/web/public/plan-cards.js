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
		<section class="plan-decision-card" aria-label="Plan review">
			<div class="plan-decision-header"><span class="plan-decision-name">plan</span><span class="plan-decision-kind">review</span></div>
			<div class="plan-decision-body">Plan ready. What next?</div>
			<div class="plan-decision-options">
				${PLAN_DECISION_OPTIONS.map(
					(option) => html`<button class="plan-decision-option" onClick=${() => onChoose(option.value)}>
						<span class="plan-decision-option-label">${option.label}${option.recommended ? " · recommended" : ""}</span>
						${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
					</button>`,
				)}
			</div>
		</section>
	`;
}

export function QuestionCard({ question, onChoose }) {
	const items = question?.questions ?? [];
	const [answers, setAnswers] = useState(() => Array(items.length).fill(null));
	if (items.length === 0) return null;
	const complete = answers.every(Boolean);
	return html`
		<section class="plan-decision-card" aria-label="Questions from agent">
			<div class="plan-decision-header"><span class="plan-decision-name">agent</span><span class="plan-decision-kind">questions</span></div>
			${items.map(
				(item, index) => html`
					<div class="plan-decision-body">${item.question}</div>
					<div class="plan-decision-options">
						${item.options.map(
							(
								option,
							) => html`<button class="plan-decision-option ${answers[index] === option.value ? "selected" : ""}" onClick=${() => setAnswers((prev) => prev.map((value, i) => (i === index ? option.value : value)))}>
								<span class="plan-decision-option-label">${option.label}${option.value === item.recommended ? " · recommended" : ""}</span>
								${option.description && html`<span class="plan-decision-option-description">${option.description}</span>`}
							</button>`,
						)}
					</div>
				`,
			)}
			<div class="plan-decision-options"><button class="plan-decision-option" disabled=${!complete} onClick=${() => onChoose(answers)}>Continue</button></div>
		</section>
	`;
}
