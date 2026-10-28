#!/usr/bin/env node
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import monosPreset from "@monos/ui/tailwind-preset";
import postcss from "postcss";
import { compile } from "svelte/compiler";
import tailwindcss from "tailwindcss";

export async function buildMonosElements(targetDirectory = "src/server/public") {
	const outputDirectory = resolve(targetDirectory);
	const utilityCss = await postcss([
		tailwindcss({
			presets: [monosPreset],
			content: [
				"node_modules/@monos/ui/src/components/Button.svelte",
				"node_modules/@monos/ui/src/components/IconButton.svelte",
			],
			corePlugins: { preflight: false },
			safelist: [
				"animate-spin",
				"bg-accent",
				"border",
				"border-accent",
				"border-danger",
				"border-dashed",
				"border-line-strong",
				"flex-1",
				"h-8",
				"hover:bg-surface",
				"hover:border-accent",
				"hover:opacity-90",
				"min-w-0",
				"normal-case",
				"px-2",
				"text-accent",
				"text-accent-text",
				"text-danger-text",
				"text-ink-soft",
				"tracking-normal",
			],
		}),
	]).process("@tailwind utilities;", { from: undefined });
	const spinnerCss = 'button.text-accent { color: var(--ui-accent); } button.text-accent-text { color: var(--ui-accent-text); } button.text-danger-text { color: var(--ui-danger-text); } @keyframes monos-spinner-rotation { to { transform: rotate(360deg); } } button[aria-busy="true"] slot::slotted(.monos-spinner) { animation: monos-spinner-rotation .7s linear infinite; }';
	const entry = `
import { Button, IconButton } from "@monos/ui";
import { ChatPanel, ChatMessage, ChatComposer } from "@monos/ui/chat";

const utilityCss = ${JSON.stringify(utilityCss.css)};
const touchTargetCss = "*,::before,::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: currentColor; } button { appearance: none; margin: 0; padding: 0; color: inherit; font: inherit; text-transform: none; background-color: transparent; background-image: none; cursor: pointer; } button:disabled { cursor: default; } button:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 2px; } button:focus:not(:focus-visible) { outline: none; } @media (pointer: coarse) { button { min-width: 44px; min-height: 44px; } }";
const spinnerCss = ${JSON.stringify(spinnerCss)};

function defineElement(name, component, { addUtilities = false, nativeClick = false } = {}) {
	if (customElements.get(name)) return;
	const BaseElement = component.element;
	class MonosElement extends BaseElement {
		addEventListener(type, listener, options) {
			// Preact needs one native click; Svelte's custom-element bridge also forwards it through its component event list.
			if (type === "click" && nativeClick) return HTMLElement.prototype.addEventListener.call(this, type, listener, options);
			return super.addEventListener(type, listener, options);
		}

		removeEventListener(type, listener, options) {
			if (type === "click" && nativeClick) return HTMLElement.prototype.removeEventListener.call(this, type, listener, options);
			return super.removeEventListener(type, listener, options);
		}

		async connectedCallback() {
			await super.connectedCallback();
			if (addUtilities && this.shadowRoot && !this.shadowRoot.querySelector("style[data-monos-utilities]")) {
				const style = document.createElement("style");
				style.dataset.monosUtilities = "";
				style.textContent = utilityCss + touchTargetCss + spinnerCss;
				this.shadowRoot.append(style);
			}
		}
	}
	customElements.define(name, MonosElement);
}

defineElement("monos-chat-panel", ChatPanel);
defineElement("monos-chat-message", ChatMessage);
defineElement("monos-chat-composer", ChatComposer);
defineElement("monos-button", Button, { addUtilities: true, nativeClick: true });
defineElement("monos-icon-button", IconButton, { addUtilities: true, nativeClick: true });
`;

	mkdirSync(outputDirectory, { recursive: true });
	await build({
		stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "monos-elements-entry.js", loader: "js" },
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		outfile: join(outputDirectory, "monos-elements.js"),
		plugins: [
			{
				name: "monos-svelte-custom-elements",
				setup(build) {
					build.onLoad({ filter: /\.svelte$/ }, (args) => {
						const result = compile(readFileSync(args.path, "utf8"), {
							filename: args.path,
							generate: "dom",
							customElement: true,
						});
						return { contents: result.js.code, loader: "js", resolveDir: dirname(args.path) };
					});
				},
			},
		],
	});

	const tokensFile = resolve("node_modules/@monos/ui/src/styles/tokens.css");
	const tokens = readFileSync(tokensFile, "utf8");
	const castTheme = `
/* Keep Monos components on Cast's active theme and type choices. */
:root {
	--ui-bg: var(--bg);
	--ui-surface: var(--bg-surface);
	--ui-surface-2: var(--bg-raised);
	--ui-ink: var(--text);
	--ui-ink-soft: var(--text-muted);
	--ui-ink-faint: var(--text-dim);
	--ui-ink-muted: var(--text-muted);
	--ui-line: var(--border);
	--ui-accent: var(--cyan);
	--ui-danger: var(--rose);
	--ui-warning: var(--amber);
	--ui-success: var(--green);
	--ui-info: var(--cyan);
	--ui-accent-text: var(--accent-fg);
	--ui-danger-text: var(--status-error-fg);
	--ui-font: var(--font);
}

monos-chat-panel {
	display: flex;
	flex: 1 1 auto;
	width: 100%;
	min-width: 0;
	min-height: 0;
	height: 100%;
}

monos-chat-message,
monos-chat-composer {
	display: block;
	min-width: 0;
}
`;
	writeFileSync(join(outputDirectory, "monos-ui.css"), `${tokens}\n${castTheme}`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const targetDirectory = process.argv[2] ?? "src/server/public";
	await buildMonosElements(targetDirectory);
	console.log(`Built Monos chat elements in ${resolve(targetDirectory)}`);
}
