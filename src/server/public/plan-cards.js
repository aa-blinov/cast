import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { lazy } from "./lazy.js";

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
