import { h } from "preact";
import { DiffPanel } from "./diff-panel.js";
import { FileExplorer } from "./file-explorer.js";
import { InputsExplorer } from "./inputs-explorer.js";
import { MemoryExplorer } from "./memory-explorer.js";

/**
 * The workspace panel (Inputs / Files / Memory / Changes) with its explorers
 * wired in — one split point instead of four imports in app.js, for a panel
 * that starts collapsed and stays that way unless someone opens a tab.
 */
export function WorkspacePanel(props) {
	return h(DiffPanel, { ...props, InputsExplorer, FileExplorer, MemoryExplorer });
}
