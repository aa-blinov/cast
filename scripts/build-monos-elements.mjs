#!/usr/bin/env node
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";

export async function buildMonosElements(targetDirectory = "src/server/public") {
	const outputDirectory = resolve(targetDirectory);
	const entry = `
import { ChatPanel, ChatMessage, ChatComposer } from "@monos/ui/chat";

for (const [name, component] of [
	["monos-chat-panel", ChatPanel],
	["monos-chat-message", ChatMessage],
	["monos-chat-composer", ChatComposer],
]) {
	if (!customElements.get(name)) customElements.define(name, component.element);
}
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
