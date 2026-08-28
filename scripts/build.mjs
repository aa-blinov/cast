#!/usr/bin/env node
/**
 * Bundles src/index.ts into a single dist/index.js — no tsx/esbuild needed
 * at runtime, unlike the dev-mode `npm start`/cast.sh path, which
 * transpiles from src/ on every invocation. Used by the release workflow
 * (see .github/workflows/release.yml) to produce what install.sh ships.
 *
 * npm dependencies (openai, @modelcontextprotocol/sdk) are bundled in too, so
 * the output needs nothing from node_modules at runtime — just Node.js
 * itself.
 *
 * import.meta.url inside bundled code resolves to dist/index.js's own
 * location for every module that got inlined into it (verified: esbuild
 * doesn't preserve per-source-file import.meta.url after bundling). Every
 * ../prompts and ../package.json read in src/ assumes "one directory below
 * the repo root" — true for src/, and still true for dist/ as long as it
 * stays a sibling of prompts/ and package.json, which is how the release
 * archive is laid out (see .github/workflows/release.yml).
 */
import { build, transform } from "esbuild";

	await build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22", // matches the oldest Node version CI actually tests (see .github/workflows/ci.yml)
		outfile: "dist/index.js",
		// node-pty contains a native addon and must remain a runtime dependency;
		// bundling JavaScript around it cannot embed the platform-specific binary.
		external: ["node-pty"],
		// ink optionally imports react-devtools-core for its DevTools integration,
		// gated behind `if (process.env.DEV === 'true')` — but that file (devtools.js)
		// is a *local* ink module, so esbuild inlines it into this single outfile
		// instead of leaving it as a separate dynamic-import chunk. Its own static
		// `import devtools from 'react-devtools-core'` then has nowhere to go but
		// the top of the bundle — and a static ESM import is resolved by Node before
		// any code runs, DEV-guard or not. Marking the package `external` used to
		// "fix" the bundle-time error, but just moved the crash to runtime: Node
		// then eagerly resolves that top-level import against the *install*
		// directory's node_modules, where the (genuinely optional, dev-only)
		// package was never installed — ERR_MODULE_NOT_FOUND on every launch.
		// Stubbing it out with an empty module keeps the bundle fully
		// self-contained; the DEV=true devtools-connect path (never exercised in
		// a release install) just gets a no-op default export instead.
		plugins: [
			{
				name: "stub-react-devtools-core",
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^react-devtools-core$/ }, () => ({
						path: "react-devtools-core",
						namespace: "stub-react-devtools-core",
					}));
					pluginBuild.onLoad({ filter: /.*/, namespace: "stub-react-devtools-core" }, () => ({
						contents: "export default {};",
						loader: "js",
					}));
				},
			},
		],
	// @modelcontextprotocol/sdk drags in zod (both v3 and v4 code paths) and
	// ajv unconditionally; minifying cuts the unminified ~1.4mb bundle back
	// down to ~800kb without touching what actually ships behaviorally.
	minify: true,
	// A CJS dependency pulled in transitively by openai (node-fetch, used by
	// its bundled fetch polyfill path) calls require() with an argument
	// esbuild can't statically resolve at bundle time, and ESM output has no
	// require at all — confirmed by testing: running the bundle without this
	// throws "Dynamic require of 'stream' is not supported". createRequire
	// gives that call a real, working require backed by Node's own resolver.
	banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
	logLevel: "info",
});

// Copy static web assets into dist/ so the bundled server can serve them.
// In the bundle, import.meta.dirname resolves to dist/ — the server looks
// for public/ as a sibling of dist/index.js.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
cpSync("src/server/public", "dist/public", { recursive: true });
cpSync("src/server/ui-factory/template", "dist/ui-factory/template", { recursive: true });

// Keep the source web assets readable for the dev server, but ship compact
// browser assets in release builds. Each module is transformed independently
// so the importmap and the browser's native ES-module graph remain intact.
const webJavaScript = [
	"app.js",
	"api.js",
	"cast-logo.js",
	"composer-pickers.js",
	"composer-attachments.js",
	"composer.js",
	"directory-browser.js",
	"diff-panel.js",
	"elapsed-timer.js",
	"file-preview.js",
	"file-size.js",
	"file-explorer.js",
	"hotkeys.js",
	"inputs-explorer.js",
	"icons.js",
	"modal-focus.js",
	"message.js",
	"memory-explorer.js",
	"plan-cards.js",
	"reasoning-split.js",
	"sidebar-utils.js",
	"sse-connection.js",
	"sse-events.js",
	"status-popover.js",
	"settings-modal.js",
	"streaming-blocks.js",
	"tool-card.js",
	"turn-meta.js",
	"use-workspace-state.js",
	"use-session-state.js",
	"use-session-controller.js",
	"use-panel-resize.js",
	"tool-card.js",
	"sidebar-session-item.js",
	"sidebar.js",
	"share-modal.js",
	"settings-model.js",
	"settings-appearance.js",
	"settings-panels.js",
	"message-submit.js",
	"slot-model-picker.js",
	"stream-blocks.js",
	"login.js",
];
// Compute a cache-bust hash for new-session-modal.js and patch the
// __NSM_HASH__ placeholder in app.js (and any future module that wants
// the same treatment). esbuild otherwise inlines the import as-is with
// no `?v=…`, so the browser's ESM module cache would hold on to a stale
// new-session-modal.js after a release even though app.js's `?v=…`
// would have changed. The placeholder approach keeps the source readable
// and makes the cache-bust a single sed-style substitution before the
// minify pass runs.
const nsmHash = createHash("sha256")
	.update(readFileSync("dist/public/new-session-modal.js"))
	.digest("hex")
	.slice(0, 12);
for (const file of webJavaScript) {
	let source = readFileSync(`dist/public/${file}`, "utf8");
	source = source.replaceAll("__NSM_HASH__", nsmHash);
	const result = await transform(source, {
		loader: "js",
		format: "esm",
		minify: true,
		legalComments: "none",
	});
	writeFileSync(`dist/public/${file}`, result.code);
}

const webStylesheets = ["tokens.css", "chat.css", "tools.css", "workspace.css", "settings.css", "style.css", "login.css"];
for (const file of webStylesheets) {
	const source = readFileSync(`dist/public/${file}`, "utf8");
	const result = await transform(source, { loader: "css", minify: true, legalComments: "none" });
	writeFileSync(`dist/public/${file}`, result.code);
}

// Stamp the PWA service worker's cache name with the release version so it
// actually rotates on every deploy — `activate` evicts any cache key that
// doesn't match CACHE, but that's a no-op if CACHE never changes (see sw.js).
const { version: castVersion } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync("dist/public/sw.js", readFileSync("dist/public/sw.js", "utf8").replaceAll("__CAST_VERSION__", castVersion));

// Same idea for the vendored image-codec WASM binaries (image-resize.ts) —
// esbuild only bundles the @jsquash/* JS glue, not these; they're read from
// disk at runtime via a path resolved relative to dist/index.js.
cpSync("wasm", "dist/wasm", { recursive: true });
