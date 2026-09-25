import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);

// The composer's textarea points at these via aria-controls and
// aria-activedescendant: focus never leaves the field while arrow keys move
// through the list, so the highlighted row is announced by its id.
export const PICKER_LIST_ID = "composer-suggestions";
export const pickerOptionId = (index) => `composer-suggestion-${index}`;

export function CommandPalette({ items, selectedIndex, running, onHover, onSelect, visible }) {
	if (!visible || items.length === 0) return null;
	return html`<div class="cmd-palette open" id=${PICKER_LIST_ID} role="listbox" aria-label="Commands">${items.map((command, index) => {
		const disabled = command.blocking && running;
		const className = `cmd-item${disabled ? " disabled" : ""}${index === selectedIndex ? " selected" : ""}`;
		return html`<div key=${command.name} id=${pickerOptionId(index)} role="option" aria-selected=${index === selectedIndex} aria-disabled=${disabled ? "true" : undefined} class=${className} onMouseEnter=${() => onHover(index)} onClick=${() => !disabled && onSelect(command.name)}><span class="cmd-name">${command.name}</span><span class="cmd-desc">${command.description}</span>${disabled && html`<span class="cmd-blocked-hint">idle only</span>`}</div>`;
	})}</div>`;
}

export function ValueSuggest({ items, selectedIndex, onHover, onSelect }) {
	if (items.length === 0) return null;
	return html`<div class="cmd-palette open" id=${PICKER_LIST_ID} role="listbox" aria-label="Personas">${items.map((item, index) => html`<div key=${item.value} id=${pickerOptionId(index)} role="option" aria-selected=${index === selectedIndex} class="cmd-item${index === selectedIndex ? " selected" : ""}" onMouseEnter=${() => onHover(index)} onClick=${() => onSelect(item.value)}><span class="cmd-name">${item.value}</span><span class="cmd-desc">${item.label}</span></div>`)}</div>`;
}
