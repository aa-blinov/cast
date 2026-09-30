import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	matchesKey,
	ScrollView,
	type SlashCommand,
	Text,
	type TuiInputListenerResult,
	type ViewportTUI,
	VStack,
} from "@earendil-works/pi-tui";
import { countTurnMessages } from "../core/session.ts";
import { reduceMotion } from "../ui/animation-clock.ts";
import type { AppModel } from "../ui/app-model.ts";
import { SLASH_COMMANDS } from "../ui/commands.ts";
import type { SegmentContext } from "../ui/statusbar.tsx";
import { theme } from "../ui/themes/index.ts";
import { ModalHost } from "./modals.ts";
import { paint } from "./paint.ts";
import { statusLine } from "./status.ts";
import { Transcript } from "./transcript.ts";

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
	private readonly status = new Text("", 0, 0);
	private readonly editor: Editor;
	private readonly modals: ModalHost;
	private lastCtrlC = 0;
	private lastEsc = 0;
	private hintTimer: NodeJS.Timeout | undefined;
	private clock: NodeJS.Timeout | undefined;
	private spinner: NodeJS.Timeout | undefined;
	private historySeen = 0;
	private commandKey = "";

	constructor(
		private readonly tui: ViewportTUI,
		private readonly onQuit: () => void,
	) {
		this.editor = new Editor(
			tui,
			{
				borderColor: (line) => paint(line, { color: theme().muted, dim: true }),
				selectList: {
					selectedPrefix: (text) => paint(text, { color: theme().accent }),
					selectedText: (text) => paint(text, { color: theme().accent, bold: true }),
					description: (text) => paint(text, { color: theme().muted }),
					scrollInfo: (text) => paint(text, { color: theme().muted }),
					noMatch: (text) => paint(text, { color: theme().muted }),
				},
			},
			{ paddingX: 1 },
		);
		this.modals = new ModalHost(tui);
		this.editor.onSubmit = (text) => this.submit(text);
		const footer = new Container();
		for (const child of [this.notice, this.pending, this.hint, this.editor, this.status]) footer.addChild(child);
		tui.setLayoutRoot(
			new VStack([
				{
					component: new ScrollView(this.transcript, {
						follow: "end",
						primary: true,
						overscroll: "chain",
						scrollbar: "auto",
					}),
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

	private onKey(data: string): TuiInputListenerResult | undefined {
		const model = this.model;
		if (!model) return undefined;
		// Ctrl+C: exit, after confirming, in every state. Stopping a turn is Esc's job.
		if (matchesKey(data, "ctrl+c")) {
			const now = Date.now();
			if (now - this.lastCtrlC < HINT_MS) this.onQuit();
			else {
				this.lastCtrlC = now;
				this.flash("Press Ctrl+C again to exit");
			}
			return { consume: true };
		}
		// Esc stops a running turn, on the second press within two seconds; the
		// draft is left as it is. Anything else Esc does (closing the autocomplete)
		// is the editor's, so it only counts when nothing of the kind is open.
		if (
			matchesKey(data, "escape") &&
			model.running &&
			!this.tui.hasOverlay() &&
			!this.editor.isShowingAutocomplete()
		) {
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

	private submit(text: string): void {
		const model = this.model;
		if (!model || !text.trim()) return;
		if (!model.canSubmit(text)) return;
		this.editor.addToHistory(text);
		this.historySeen++;
		this.editor.setText("");
		void model.handleSubmit(text);
	}

	private syncCommands(model: AppModel): void {
		const skills = model.skills;
		const key = skills.map((s) => `${s.name}:${s.argumentHint ?? ""}`).join("|");
		if (key === this.commandKey) return;
		this.commandKey = key;
		const builtin = new Set(SLASH_COMMANDS.map((c) => c.name));
		const commands: SlashCommand[] = [
			...SLASH_COMMANDS.map((c) => ({ name: c.name.slice(1), description: c.description })),
			...skills
				.filter((s) => !builtin.has(`/${s.name}`))
				.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint })),
		];
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
	}

	private syncHistory(prompts: readonly string[]): void {
		// Oldest first, only what the editor has not been given: a prompt sent here
		// was added on submit, the rest came from history loaded with the session.
		if (this.historySeen === 0) {
			for (const prompt of [...prompts].reverse()) this.editor.addToHistory(prompt);
			this.historySeen = prompts.length;
		}
	}

	private paintFooter(model: AppModel): void {
		const colors = theme();
		this.notice.setText(model.notice ? paint(model.notice, { color: colors.warning }) : "");
		const rows: string[] = [];
		for (const [label, items] of [
			["Steer queued", model.agent.pendingSteers],
			["Queued", model.agent.pendingQueue],
		] as const) {
			items.slice(0, MAX_PENDING_ROWS).forEach((text, i) => {
				const count = items.length > 1 ? ` (${i + 1}/${items.length})` : "";
				rows.push(paint(`[${label}${count}: ${text.replace(/\s+/g, " ")}]`, { color: colors.warning }));
			});
			if (items.length > MAX_PENDING_ROWS) {
				rows.push(paint(`[+${items.length - MAX_PENDING_ROWS} more queued]`, { color: colors.warning }));
			}
		}
		this.pending.setText(rows.join("\n"));
		const columns = this.tui.terminal.columns;
		const { agent, session, config } = model;
		const ctx: SegmentContext = {
			persona: model.currentPersona.label,
			planMode: model.planMode,
			activeModel: model.activeModel,
			configuredModel: session.model,
			planModel: model.planModel,
			usage: agent.usage ?? undefined,
			lastTurnUsage: agent.lastTurnUsage ?? undefined,
			elapsedMs: agent.getElapsedMs(),
			messageCount: countTurnMessages(session.messages),
			contextWindow: config.contextWindow,
			maxResponseTokens: config.maxResponseTokens,
			messages: session.messages,
			sessionId: session.id,
			worktree: model.cwd.includes("/.cast/worktrees/")
				? model.cwd.split("/.cast/worktrees/")[1]?.split("/")[0]
				: undefined,
			lspServers: model.lspServers,
		};
		this.status.setText(statusLine(ctx, model.statusBar, Math.max(20, columns)));
	}

	/** Called on every render of the app model. */
	update(model: AppModel): void {
		const previous = this.model;
		this.model = model;
		const { agent } = model;
		this.transcript.set({
			messages: agent.messages,
			streaming: agent.streaming,
			error: agent.error,
			retry: agent.retry,
			showReasoning: agent.showReasoning,
		});
		this.syncCommands(model);
		this.syncHistory(model.promptHistory);
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
		if (!reduceMotion()) {
			this.spinner = setInterval(() => {
				if (this.transcript.tick()) this.tui.requestRender();
			}, SPINNER_MS);
		}
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

	dispose(): void {
		this.stopClocks();
		if (this.hintTimer) clearTimeout(this.hintTimer);
		this.modals.dispose();
	}
}
