/**
 * Semantic color map for the TUI theme. Every color the UI renders comes from
 * here — components never hardcode hex values or Ink named colors directly.
 */
export interface ThemeColors {
	/** Brand gradient endpoints — used for the startup banner, composer border, spinner. */
	gradient: { from: string; to: string };
	/** Chat: user message role label. */
	user: string;
	/** Chat: agent/assistant message role label. */
	agent: string;
	/** Chat: tool call label (e.g. "[bash]"). */
	tool: string;
	/** Header bar: persona name. */
	persona: string;
	/** Composer prompt character (">"), active UI highlights. */
	accent: string;
	/** Positive status, successful tool completion, image attached. */
	success: string;
	/** Notices, warnings, queued messages, running status. */
	warning: string;
	/** Errors, failed tools, deletions (line churn). */
	error: string;
	/** Dimmed text: timestamps, separators, inactive palette rows, help hints. */
	muted: string;
	/** Deepest page background. */
	bg: string;
	/** Surface panels — sidebar, composer, modals, tool cards. */
	bgSurface: string;
	/** Raised surfaces — active tabs, toasts, inline code, table headers. */
	bgRaised: string;
	/** Hover/highlight surfaces — list items, settings tabs, menu items. */
	bgHover: string;
	/** Subtle borders — separators, inputs, cards. */
	border: string;
	/** Active/focused borders. */
	borderActive: string;
}

export interface Theme {
	id: string;
	label: string;
	/** Short description shown in the theme picker. */
	description: string;
	colors: ThemeColors;
}
