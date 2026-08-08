const isMac =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const modKeys = isMac ? ["⌘"] : ["Ctrl"];
const modShiftKeys = isMac ? ["⌘", "⇧"] : ["Ctrl", "Shift"];
export const modKey = modKeys.join("");

const kc = (...keys) => keys.map((key) => `<kbd class="hotkey-key">${key}</kbd>`).join("");

export const hotkeysHtml = `
	<div class="hotkey-group">
		<div class="hotkey-group-title">General</div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle sidebar</span><span class="hotkey-keys">${kc(...modKeys, "B")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle diff</span><span class="hotkey-keys">${kc(...modShiftKeys, "D")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New session</span><span class="hotkey-keys">${kc(...modShiftKeys, "N")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Clear context</span><span class="hotkey-keys">${kc(...modShiftKeys, "L")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Show shortcuts</span><span class="hotkey-keys">${kc(...modKeys, "/")}</span></div>
	</div>
	<div class="hotkey-group">
		<div class="hotkey-group-title">Composer</div>
		<div class="hotkey-row"><span class="hotkey-label">Send message</span><span class="hotkey-keys">${kc("↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New line</span><span class="hotkey-keys">${kc("⇧", "↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Abort run</span><span class="hotkey-keys">${kc("Esc")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Navigate suggestions</span><span class="hotkey-keys">${kc("↑", "↓")}</span></div>
	</div>
`;
