import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStatusBarConfig, type SegmentContext } from "../src/ui/statusbar.ts";
import { ALL_THEMES, getActiveTheme, setActiveTheme } from "../src/ui/themes/index.ts";
import { messageLines, toolRowLines } from "../src/ui-pi/lines.ts";
import { OptionModal } from "../src/ui-pi/modals.ts";
import { statusLine } from "../src/ui-pi/status.ts";
import { setSurfaces } from "../src/ui-pi/surface.ts";

const first = getActiveTheme().id;
afterEach(() => {
	setActiveTheme(first);
	setSurfaces({});
});

const ctx: SegmentContext = {
	persona: "Senior Developer",
	planMode: false,
	activeModel: "mock-model",
	configuredModel: "mock-model",
	planModel: undefined,
	usage: undefined,
	lastTurnUsage: undefined,
	elapsedMs: 3000,
	messageCount: 1,
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	messages: [],
	sessionId: "s",
};

describe("every theme", () => {
	it("has a valid hex for each colour the terminal front end paints with", () => {
		for (const theme of ALL_THEMES) {
			for (const key of [
				"user",
				"agent",
				"tool",
				"persona",
				"accent",
				"success",
				"warning",
				"error",
				"muted",
				"border",
			] as const) {
				expect(theme.colors[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
			}
			expect(theme.colors.gradient.from, `${theme.id}.gradient.from`).toMatch(/^#[0-9a-fA-F]{6}$/);
			expect(theme.colors.gradient.to, `${theme.id}.gradient.to`).toMatch(/^#[0-9a-fA-F]{6}$/);
		}
	});

	it("draws the transcript, a tool row, the status row and a picker inside the width", () => {
		setSurfaces({ foreground: { r: 230, g: 230, b: 230 }, background: { r: 10, g: 10, b: 12 } });
		for (const theme of ALL_THEMES) {
			setActiveTheme(theme.id);
			const rows = [
				...messageLines(
					{ role: "user", content: "a question that runs on long enough to wrap around the line" },
					{ width: 44, showReasoning: false },
				),
				...messageLines(
					{
						role: "assistant",
						content: "",
						blocks: [{ kind: "content", text: "an answer with `code` and **bold** text, long enough to wrap" }],
					},
					{ width: 44, showReasoning: false },
				),
				...toolRowLines(
					{ id: "t", name: "bash", args: '{"command":"ls -la /very/long/path/that/goes/on"}', status: "error" },
					44,
				),
				statusLine(ctx, defaultStatusBarConfig(), 44),
				...new OptionModal([{ value: 1, label: "One", hint: "value" }], { title: theme.id }, () => {}).render(44),
			];
			for (const row of rows) expect(visibleWidth(row), `${theme.id}: ${row}`).toBeLessThanOrEqual(44);
		}
	});
});

describe("theme roles stay tellable apart", () => {
	// A failed row and an AGENT heading in one colour read as the same thing; every theme keeps what must never be
	// confused (error, warning, success, and the speakers) on different colours.
	it("never gives an error the colour of a speaker, the accent, or another status", () => {
		for (const theme of ALL_THEMES) {
			const c = theme.colors;
			for (const other of ["user", "agent", "tool", "persona", "accent", "success", "warning"] as const) {
				expect(c.error.toLowerCase(), `${theme.id}: error vs ${other}`).not.toBe(c[other].toLowerCase());
			}
			expect(c.agent.toLowerCase(), `${theme.id}: agent vs user`).not.toBe(c.user.toLowerCase());
			expect(c.success.toLowerCase(), `${theme.id}: success vs warning`).not.toBe(c.warning.toLowerCase());
		}
	});
});
