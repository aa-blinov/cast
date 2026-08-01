import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);

export function CommandPalette({ items, selectedIndex, running, onHover, onSelect, visible }) {
	if (!visible || items.length === 0) return null;
	return html`<div class="cmd-palette open">${items.map((command, index) => {
		const disabled = command.blocking && running;
		const className = `cmd-item${disabled ? " disabled" : ""}${index === selectedIndex ? " selected" : ""}`;
		return html`<div key=${command.name} class=${className} onMouseEnter=${() => onHover(index)} onClick=${() => !disabled && onSelect(command.name)}><span class="cmd-name">${command.name}</span><span class="cmd-desc">${command.description}</span>${disabled && html`<span class="cmd-blocked-hint">idle only</span>`}</div>`;
	})}</div>`;
}

export function ValueSuggest({ items, selectedIndex, onHover, onSelect }) {
	if (items.length === 0) return null;
	return html`<div class="cmd-palette open">${items.map((item, index) => html`<div key=${item.value} class="cmd-item${index === selectedIndex ? " selected" : ""}" onMouseEnter=${() => onHover(index)} onClick=${() => onSelect(item.value)}><span class="cmd-name">${item.value}</span><span class="cmd-desc">${item.label}</span></div>`)}</div>`;
}
