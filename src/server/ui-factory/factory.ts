import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RESERVED_UI_NAMES } from "../ui-registry.ts";

const TEMPLATE_DIR = join(import.meta.dirname ?? ".", "template");

function renderTemplate(src: string, vars: Record<string, string>): string {
	let out = src;
	for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
	return out;
}

const UI_NAME_RE = /^[a-z0-9-]+$/;

export function createUi(name: string, opts?: { dest?: string; templateVars?: Record<string, string> }): string {
	if (!UI_NAME_RE.test(name)) throw new Error("UI name must be lowercase a-z, 0-9, hyphens only");
	if (RESERVED_UI_NAMES.has(name)) throw new Error(`UI name "${name}" is reserved — use another slug`);
	const dest = opts?.dest ?? join(homedir(), ".cast", "ui", name);
	if (existsSync(dest)) throw new Error(`UI already exists: ${dest}`);
	mkdirSync(dest, { recursive: true });
	const vars = { UI_NAME: name, ...(opts?.templateVars ?? {}) };
	// copy template files with placeholder substitution
	const entries = readdirSync(TEMPLATE_DIR, { withFileTypes: true });
	for (const e of entries) {
		const srcPath = join(TEMPLATE_DIR, e.name);
		const dstPath = join(dest, e.name);
		if (e.isDirectory()) {
			cpSync(srcPath, dstPath, { recursive: true });
			// placeholder in subfiles if any
			for (const _sub of readdirSync(dstPath, { recursive: true } as any) as string[]) {
				// not needed for now — template is flat
			}
		} else {
			const raw = readFileSync(srcPath, "utf-8");
			const rendered = renderTemplate(raw, vars);
			writeFileSync(dstPath, rendered, "utf-8");
		}
	}
	// Ensure required skeleton is present — new UIs must not lose threads/composer/settings
	// Skeleton contract (BACKBONE): Sidebar (threads) + Composer + SettingsModal (real tabs, not stub) + sessions/settingsOpen state.
	const appContent = readFileSync(join(dest, "app.js"), "utf-8");
	const required = [
		"Sidebar",
		"Composer",
		"SettingsModal",
		"sessions",
		"settingsOpen",
		'api("GET","/api/system/version")',
	];
	const missing = required.filter((k) => !appContent.includes(k));
	if (missing.length > 0)
		throw new Error(
			`Template missing required skeleton sections: ${missing.join(", ")} — new UI would lose threads/composer/settings. ` +
				`Skeleton is the backbone; generate only LAYOUT/THEME + style.css on top.`,
		);
	// Guard against халтура stub: SettingsModal must handle real tabs, not just link to /default/settings
	if (
		appContent.includes("// threads and settings are required sections — full settings live at /default/settings") &&
		!appContent.includes('tab==="appearance"')
	) {
		throw new Error(
			`Settings is a stub — replace with real skeleton SettingsModal (General + Appearance tabs, Default UI, Updates, Server).`,
		);
	}
	return dest;
}

export function listTemplateFiles(): string[] {
	try {
		return readdirSync(TEMPLATE_DIR).filter((f) => !f.startsWith("."));
	} catch {
		return [];
	}
}
