import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);

function SettingsTheme({ themes, currentThemeId, onPick }) {
	return html`<div class="settings-theme-grid">${[...(themes || [])].sort((a, b) => a.label.localeCompare(b.label)).map((theme) => html`<button key=${theme.id} class="settings-theme-swatch${theme.id === currentThemeId ? " active" : ""}" style=${{ "--swatch-accent": theme.colors?.accent }} onClick=${() => onPick(theme.id)} title=${theme.description}><span class="settings-theme-dot" /><span class="settings-theme-label">${theme.label}</span></button>`)}</div>`;
}

function SettingsFont({ options, scales, currentFontId, currentFontScale, onPickFont, onPickScale }) {
	const renderFonts = (mono) =>
		options
			.filter((font) => font.mono === mono)
			.map(
				(font) =>
					html`<button key=${font.id} class="settings-font-swatch${font.id === currentFontId ? " active" : ""}" style=${{ fontFamily: font.family }} onClick=${() => onPickFont(font.id)}>${font.label}</button>`,
			);
	return html`<div class="settings-font-settings"><div class="settings-row-label">Scale</div><div class="settings-scale-row">${scales.map((scale) => html`<button key=${scale} class="settings-scale-btn${scale === currentFontScale ? " active" : ""}" onClick=${() => onPickScale(scale)}>${Math.round(scale * 100)}%</button>`)}</div><div class="settings-row-label">Monospace</div><div class="settings-font-grid">${renderFonts(true)}</div><div class="settings-row-label">Sans-serif</div><div class="settings-font-grid">${renderFonts(false)}</div></div>`;
}

export function SettingsAppearance({
	themes,
	currentThemeId,
	onPickTheme,
	fontOptions,
	fontScales,
	currentFontId,
	currentFontScale,
	onPickFont,
	onPickScale,
}) {
	return html`<div class="settings-rows"><div class="settings-section-title">Theme</div><${SettingsTheme} themes=${themes} currentThemeId=${currentThemeId} onPick=${onPickTheme} /><div class="settings-section-title">Font</div><${SettingsFont} options=${fontOptions} scales=${fontScales} currentFontId=${currentFontId} currentFontScale=${currentFontScale} onPickFont=${onPickFont} onPickScale=${onPickScale} /></div>`;
}
