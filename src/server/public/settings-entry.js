import { h } from "preact";
import { SettingsAppearance } from "./settings-appearance.js";
import { SettingsModal } from "./settings-modal.js";
import { SettingsModel } from "./settings-model.js";
import {
	SettingsBash,
	SettingsHooks,
	SettingsMcp,
	SettingsMemory,
	SettingsPersonas,
	SettingsProvider,
	SettingsQuickMode,
	SettingsServer,
	SettingsSkills,
	SettingsSkillssh,
	SettingsSsh,
	SettingsUpdates,
	SettingsWeb,
} from "./settings-panels.js";

/**
 * The settings modal with its panels already wired in.
 *
 * It exists so the split point is one module: app.js used to import all
 * sixteen panels itself and hand them down as a `panels` prop, which meant
 * 80KB of settings code on every first paint whether or not anyone opened
 * settings. The prop stays — settings-modal.js is unchanged — it is just
 * filled in here, on the other side of the dynamic import.
 */
const PANELS = {
	SettingsAppearance,
	SettingsModel,
	SettingsBash,
	SettingsWeb,
	SettingsMemory,
	SettingsPersonas,
	SettingsQuickMode,
	SettingsServer,
	SettingsHooks,
	SettingsMcp,
	SettingsSkills,
	SettingsSkillssh,
	SettingsProvider,
	SettingsSsh,
	SettingsUpdates,
};

export function Settings(props) {
	return h(SettingsModal, { ...props, panels: PANELS });
}
