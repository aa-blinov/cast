import { execFileSync } from "node:child_process";
import {
	type Component,
	Container,
	ScrollView,
	type SlashCommand,
	Text,
	type TuiInputListenerResult,
	type ViewportTUI,
	VStack,
} from "@earendil-works/pi-tui";
import { formatGoalSegment, readGoal } from "../core/goal.ts";
import { mcpPromptCommands } from "../core/mcp.ts";
import { skillInvocationLabel } from "../core/session-title.ts";
import { loadSettings, runningInputMode, type StatusBarConfig } from "../core/settings.ts";
import type { AppModel } from "../ui/app-model.ts";
import { SLASH_COMMANDS } from "../ui/commands.ts";
import { editInExternalEditor } from "../ui/external-editor.ts";
import { headerTexts } from "../ui/header.ts";
import { getKeybindings, keyLabel } from "../ui/input/keybindings.ts";
import type { ClipboardPasteResult } from "../ui/readClipboardImage.ts";
import { railMuted } from "../ui/span-style.ts";
import { type SegmentContext, tildePath } from "../ui/statusbar.ts";
import { FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, setTerminalFocused } from "../ui/terminal-notify.ts";
import { theme } from "../ui/themes/index.ts";
import { bannerRows } from "./banner.ts";
import { foldCommandVariants } from "./command-palette.ts";
import { CastAutocompleteProvider, CastEditor } from "./editor.ts";
import { ModalHost } from "./modals.ts";
import { paint } from "./paint.ts";
import { sanitize } from "./sanitize.ts";
import { statusLine } from "./status.ts";
import { Transcript } from "./transcript.ts";

/** The status bar, laid out for whatever width the screen has when it is drawn. */
class StatusRow implements Component {
	private ctx: SegmentContext | undefined;
	private config: StatusBarConfig | undefined;

	set(ctx: SegmentContext, config: StatusBarConfig): void {
		this.ctx = ctx;
		this.config = config;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.ctx || !this.config) return [];
		return [statusLine(this.ctx, this.config, Math.max(20, width))];
	}
}

/** Where `fd` is, if anywhere: `@` file suggestions are fuzzy only with it. */
function findFd(): string | null {
	for (const name of ["fd", "fdfind"]) {
		try {
			const found = execFileSync("which", [name], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (found) return found;
		} catch {
			// not installed under this name
		}
	}
	return null;
}

/** A notice reads as a sentence: `[Cancelled — x]` and `Cancelled — x` are the same notice. */
export function unbracket(text: string): string {
	const t = text.trim();
	return t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
}

const IDLE_PLACEHOLDER = "ask cast to do anything";
// The footer repaints on every streamed token, and the mode lives in the settings file: read it at most once a second.
let hintMode: ReturnType<typeof runningInputMode> = "steer";
let hintReadAt = 0;
const runningPlaceholder = () => {
	if (Date.now() - hintReadAt > 1_000) {
		hintMode = runningInputMode(loadSettings());
		hintReadAt = Date.now();
	}
	const other = getKeybindings().keysFor("input.otherMode")[0];
	const otherHint = other ? ` * ${keyLabel(other)} ${hintMode === "steer" ? "queues" : "steers"}` : "";
	return `type to ${hintMode}${otherHint} * esc esc to stop`;
};
const HINT_MS = 2000;
const SPINNER_MS = 200;
const MAX_PENDING_ROWS = 3;

/**
 * The pi-tui front end. It owns no state of its own beyond what is on screen:
 * every render of the app model calls `update`, which sets the transcript, the
 * footer and the open modal from it.
 */
export class PiApp {
	private model: AppModel | undefined;
	private readonly transcript = new Transcript();
	private readonly notice = new Text("", 1, 0);
	private readonly pending = new Text("", 1, 0);
	private readonly hint = new Text("", 1, 0);
	private readonly status = new StatusRow();
	private readonly editor: CastEditor;
	private readonly scrollView: ScrollView;
	private readonly modals: ModalHost;
	private lastCtrlC = 0;
	private lastEsc = 0;
	private hintTimer: NodeJS.Timeout | undefined;
	private staleDraw: NodeJS.Immediate | undefined;
	private clock: NodeJS.Timeout | undefined;
	private spinner: NodeJS.Timeout | undefined;
	private historySeen = 0;
	private historySession: string | undefined;
	private commandKey = "";
	private readonly fdPath = findFd();

	constructor(
		private readonly tui: ViewportTUI,
		private readonly onQuit: () => void,
		private readonly version: string,
		private readonly onPasteImage?: () => Promise<ClipboardPasteResult>,
	) {
		this.editor = new CastEditor(
			tui,
			{
				// Hairlines, as quiet as the rest of the page's rules.
				borderColor: (line) => paint(line, { color: railMuted(), exact: true }),
				selectList: {
					selectedPrefix: (text) => paint(text.replace("→", "▸"), { color: theme().accent }),
					// pi-tui draws the chosen row's marker as `→`; every other list here uses `▸`.
					selectedText: (text) => paint(text.replace("→", "▸"), { color: theme().accent, bold: true }),
					description: (text) => paint(text, { color: theme().muted }),
					scrollInfo: (text) => paint(text, { color: theme().muted }),
					noMatch: (text) => paint(text, { color: theme().muted }),
				},
			},
			{ paddingX: 1 },
		);
		this.modals = new ModalHost(tui);
		this.editor.onSubmit = (text) => this.submit(text);
		// A frame that left some messages on their old layout (it stops at its time budget) asks for another, between
		// the input events that arrive meanwhile.
		this.transcript.onStale = () => {
			if (this.staleDraw) return;
			this.staleDraw = setImmediate(() => {
				this.staleDraw = undefined;
				this.tui.requestRender();
			});
		};
		this.scrollView = new ScrollView(this.transcript, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => paint(text, { color: theme().border }),
			scrollbarThumbStyle: (text) => paint(text, { color: railMuted(), exact: true }),
		});
		const footer = new Container();
		for (const child of [this.notice, this.pending, this.hint, this.editor, this.status]) footer.addChild(child);
		tui.setLayoutRoot(
			new VStack([
				{
					component: this.scrollView,
					basis: 0,
					grow: 1,
					minSize: 1,
				},
				{ component: footer, basis: "auto", shrink: 1, minSize: 1 },
			]),
		);
		tui.setFocus(this.editor);
		tui.addInputListener((data) => this.onKey(data));
	}

	private flash(text: string): void {
		this.hint.setText(paint(text, { color: theme().warning }));
		if (this.hintTimer) clearTimeout(this.hintTimer);
		this.hintTimer = setTimeout(() => {
			this.hint.setText("");
			this.tui.requestRender();
		}, HINT_MS);
		this.tui.requestRender();
	}

	/** Puts the saved clipboard image's path into the draft, the way the old composer does. */
	private attachImage(): void {
		if (!this.onPasteImage) {
			this.flash("[Image paste not available]");
			return;
		}
		this.flash("[Reading clipboard...]");
		void this.onPasteImage().then((result) => {
			if (result.ok) {
				this.editor.insertTextAtCursor(result.path);
				this.flash(`[Image saved: ${result.path}]`);
			} else if (result.error) this.flash(`[${result.error}]`);
			else this.flash("[No image in clipboard — copy a screenshot or image file first]");
		});
	}

	/** The draft goes to $VISUAL / $EDITOR and comes back as the new draft. */
	private editExternally(): void {
		void editInExternalEditor(this.editor.getExpandedText()).then((result) => {
			if (result.ok) this.editor.setText(result.text);
			else this.flash(`[${result.error}]`);
			this.tui.requestRender(true);
		});
	}

	/** Whether a question has the keyboard (a picker, a prompt): the progress box of a slow step does not. */
	private modalOpen(): boolean {
		const request = this.model?.modalRequest;
		return request !== null && request !== undefined && request.kind !== "status";
	}

	private onKey(data: string): TuiInputListenerResult | undefined {
		// The terminal says when its window gains or loses focus (DEC mode 1004);
		// a notification is only worth sending while it is out of focus.
		if (data === "\x1b[I" || data === "\x1b[O") {
			setTerminalFocused(data === "\x1b[I");
			return { consume: true };
		}
		const model = this.model;
		if (!model) return undefined;
		const keys = getKeybindings();
		// PageUp at the very top is asking for what came before: page it in. The key
		// still goes on to the scroll view, which has nothing left to scroll until
		// the older turns land.
		// With a question open these keys belong to it, not to the draft behind it: Ctrl+L would wipe the
		// draft, Ctrl+G put a path into it, Ctrl+X suspend the screen under a pending permission.
		const asking = this.modalOpen();
		if (!asking && keys.matches(data, "history.older") && this.scrollView.scrollTop === 0 && model.agent.hasOlder) {
			void model.onLoadOlder();
		}
		if (!asking && keys.matches(data, "input.attachImage")) {
			this.attachImage();
			return { consume: true };
		}
		if (!asking && keys.matches(data, "input.externalEditor")) {
			this.editExternally();
			return { consume: true };
		}
		if (!asking && keys.matches(data, "editor.clearBuffer")) {
			this.editor.setText("");
			this.tui.requestRender();
			return { consume: true };
		}
		// Ctrl+Q: exit at once, in every state, a question open or not. The session is saved on the way out, as for
		// /quit and the confirmed Ctrl+C.
		if (keys.matches(data, "input.quit")) {
			this.onQuit();
			return { consume: true };
		}
		// Ctrl+C: exit, after confirming, in every state. Stopping a turn is Esc's job.
		if (!keys.matches(data, "input.abort") && !data.startsWith("\x1b[<")) this.lastCtrlC = 0;
		if (keys.matches(data, "input.abort")) {
			const now = Date.now();
			if (now - this.lastCtrlC < HINT_MS) {
				this.lastCtrlC = 0;
				this.onQuit();
			} else {
				this.lastCtrlC = now;
				const quit = keys.keysFor("input.quit")[0];
				this.flash(quit ? `Ctrl+C again to exit, or ${keyLabel(quit)} at once` : "Press Ctrl+C again to exit");
			}
			return { consume: true };
		}
		// Esc stops a running turn, on the second press within two seconds; the
		// draft is left as it is. Anything else Esc does (closing the autocomplete)
		// is the editor's, so it only counts when nothing of the kind is open.
		// Alt+Enter while a turn runs sends the draft the other way from Enter: queued when Enter steers. Idle, it is
		// the editor's (a line break), as before.
		if (model.running && !asking && !this.editor.isShowingAutocomplete() && keys.matches(data, "input.otherMode")) {
			const text = this.editor.getText();
			if (text.trim()) this.submit(text, { otherMode: true });
			return { consume: true };
		}
		if (keys.matches(data, "input.escape") && model.running && !asking && !this.editor.isShowingAutocomplete()) {
			const now = Date.now();
			if (now - this.lastEsc < HINT_MS) {
				this.lastEsc = 0;
				model.agent.abort();
			} else {
				this.lastEsc = now;
				this.flash("Press Esc again to stop the turn");
			}
			return { consume: true };
		}
		return undefined;
	}

	private submit(text: string, options?: { otherMode?: boolean }): void {
		const model = this.model;
		if (!model || !text.trim()) return;
		// pi-tui has already emptied the composer: a refused message (a command during a turn, a lost daemon) goes
		// back into it, as the notice says it does.
		if (!model.canSubmit(text)) {
			this.editor.setText(text);
			return;
		}
		this.editor.addToHistory(text);
		this.historySeen++;
		this.editor.setText("");
		void model.handleSubmit(text, options);
	}

	private syncCommands(model: AppModel): void {
		const skills = model.skills;
		// What the connected MCP servers offer as prompts: `/mcp:<server>:<prompt>`.
		const mcpPrompts = mcpPromptCommands(model.mcpResult);
		const key = `${model.cwd}|${skills.map((s) => `${s.name}:${s.argumentHint ?? ""}`).join("|")}|${mcpPrompts.map((c) => `${c.name}:${c.argumentHint ?? ""}`).join("|")}`;
		if (key === this.commandKey) return;
		this.commandKey = key;
		const builtin = new Set(SLASH_COMMANDS.map((c) => c.name));
		const skillCommands: SlashCommand[] = skills
			.filter((s) => !builtin.has(`/${s.name}`))
			.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint }));
		const commands: SlashCommand[] = [
			...foldCommandVariants(
				SLASH_COMMANDS.filter((c) => !c.hidden).map((c) => ({ name: c.name.slice(1), description: c.description })),
			),
			...skillCommands,
			...mcpPrompts.map((c) => ({
				name: c.name.slice(1),
				description: c.description,
				argumentHint: c.argumentHint,
			})),
		].map((c) => ({ ...c, description: c.description === undefined ? undefined : sanitize(c.description) }));
		const hidden = new Set(
			SLASH_COMMANDS.filter((c) => c.hidden && !c.name.includes(" ")).map((c) => c.name.slice(1)),
		);
		this.editor.setAutocompleteProvider(
			new CastAutocompleteProvider(commands, model.cwd, this.fdPath, hidden, skillCommands),
		);
	}

	private syncHistory(sessionId: string, prompts: readonly string[]): void {
		// /new and /resume switch to another conversation: its prompts, not the last one's.
		if (this.historySession !== undefined && this.historySession !== sessionId) {
			this.editor.resetHistory();
			this.historySeen = 0;
		}
		this.historySession = sessionId;
		// Oldest first, only what the editor has not been given: a prompt sent here
		// was added on submit, the rest came from history loaded with the session.
		if (this.historySeen === 0) {
			// Oldest first, as they were sent: the editor puts each in front of the last. A
			// /skill command comes back as the command, not the SKILL.md it expanded to.
			for (const prompt of prompts) this.editor.addToHistory(skillInvocationLabel(prompt) ?? prompt);
			this.historySeen = prompts.length;
		}
	}

	private paintFooter(model: AppModel): void {
		const colors = theme();
		this.editor.placeholder = model.running ? runningPlaceholder() : IDLE_PLACEHOLDER;
		this.notice.setText(
			model.notice ? paint(`  ${sanitize(unbracket(model.notice))}`, { color: colors.warning }) : "",
		);
		const rows: string[] = [];
		for (const [label, items] of [
			["Steer queued", model.agent.pendingSteers],
			["Queued", model.agent.pendingQueue],
		] as const) {
			items.slice(0, MAX_PENDING_ROWS).forEach((text, i) => {
				const count = items.length > 1 ? ` (${i + 1}/${items.length})` : "";
				rows.push(paint(`[${label}${count}: ${sanitize(text).replace(/\s+/g, " ")}]`, { color: colors.warning }));
			});
			if (items.length > MAX_PENDING_ROWS) {
				rows.push(paint(`[+${items.length - MAX_PENDING_ROWS} more queued]`, { color: colors.warning }));
			}
		}
		this.pending.setText(rows.join("\n"));
		const { agent, session, config } = model;
		const ctx: SegmentContext = {
			persona: sanitize(model.currentPersona.label),
			planMode: model.planMode,
			activeModel: sanitize(model.activeModel),
			configuredModel: sanitize(session.model),
			planModel: model.planModel,
			usage: agent.usage ?? undefined,
			lastTurnUsage: agent.lastTurnUsage ?? undefined,
			elapsedMs: agent.getElapsedMs(),
			running: model.running,
			// What the screen shows, not `session.messages`: attached to the daemon that list is never filled in here.
			messageCount: agent.messages.filter((m) => m.role === "user").length,
			contextWindow: config.contextWindow,
			maxResponseTokens: config.maxResponseTokens,
			messages: session.messages,
			sessionId: session.id,
			cwd: sanitize(model.cwd),
			worktree: model.cwd.includes("/.cast/worktrees/")
				? model.cwd.split("/.cast/worktrees/")[1]?.split("/")[0]
				: undefined,
			lspServers: model.lspServers,
			goal: this.goalSegment(session.id),
		};
		this.status.set(ctx, model.statusBar);
	}

	private goalRead: { id: string; at: number; text: string | undefined } | undefined;

	/** The goal phrase for the status bar, read from its file at most once a second: the bar repaints on every spinner tick. */
	private goalSegment(sessionId: string): string | undefined {
		const now = Date.now();
		if (this.goalRead?.id !== sessionId || now - this.goalRead.at > 1000) {
			this.goalRead = { id: sessionId, at: now, text: formatGoalSegment(readGoal(sessionId)) };
		}
		return this.goalRead.text;
	}

	/** Called on every render of the app model. */
	update(model: AppModel): void {
		const previous = this.model;
		this.model = model;
		// A turn that has ended is not the one a first Esc was meant for.
		if (previous?.running && !model.running) this.lastEsc = 0;
		const { agent } = model;
		this.transcript.set({
			messages: agent.messages,
			streaming: agent.streaming,
			error: agent.error,
			retry: agent.retry,
			showReasoning: agent.showReasoning,
		});
		const parts = headerTexts(model.header, {
			persona: model.currentPersona.label,
			model: model.activeModel,
			version: this.version,
			folder: tildePath(model.cwd),
		});
		this.transcript.header = (width) => bannerRows(parts.map(sanitize), width);
		this.syncCommands(model);
		this.syncHistory(model.session.id, model.promptHistory);
		this.paintFooter(model);
		this.modals.sync(model.modalRequest);
		const wasRunning = previous?.running ?? false;
		if (model.running && !wasRunning) this.startClocks();
		if (!model.running && wasRunning) this.stopClocks();
		this.tui.requestRender();
	}

	/** The status row's counter ticks once a second; the activity dot a few times. */
	private startClocks(): void {
		this.stopClocks();
		this.clock = setInterval(() => {
			if (!this.model) return;
			this.paintFooter(this.model);
			this.tui.requestRender();
		}, 1000);
		this.spinner = setInterval(() => {
			if (this.transcript.tick()) this.tui.requestRender();
		}, SPINNER_MS);
	}

	private stopClocks(): void {
		if (this.clock) clearInterval(this.clock);
		if (this.spinner) clearInterval(this.spinner);
		this.clock = undefined;
		this.spinner = undefined;
	}

	/** The transcript's colours or contents changed under what is drawn. */
	repaint(): void {
		this.transcript.invalidate();
		this.tui.requestRender(true);
	}

	/** Asks the terminal to report focus changes; undone by `dispose`. */
	start(): void {
		process.stdout.write(FOCUS_REPORTING_ON);
	}

	dispose(): void {
		process.stdout.write(FOCUS_REPORTING_OFF);
		this.stopClocks();
		if (this.staleDraw) clearImmediate(this.staleDraw);
		if (this.hintTimer) clearTimeout(this.hintTimer);
		this.modals.dispose();
	}
}
