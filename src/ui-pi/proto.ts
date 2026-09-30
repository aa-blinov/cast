import {
	Container,
	Editor,
	isViewportTUI,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "../core/loop.ts";
import {
	abortServerSession,
	createServerSession,
	ensureServerClient,
	submitServerChat,
	subscribeServerEvents,
} from "../server/client.ts";

// A prototype, not the TUI: one transcript in a scroll view the application owns
// (so a repaint can never drag the viewport), an editor, and a status line,
// driven by the same daemon events the Ink TUI reads. Launched with CAST_TUI=pi.

const ansi = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const dim = ansi("2");
const bold = ansi("1");
const cyan = ansi("36");
const green = ansi("32");
const red = ansi("31");
const passthrough = (text: string) => text;

const markdownTheme = {
	heading: bold,
	link: cyan,
	linkUrl: dim,
	code: cyan,
	codeBlock: passthrough,
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: cyan,
	bold,
	italic: ansi("3"),
	strikethrough: ansi("9"),
	underline: ansi("4"),
};

const selectListTheme = {
	selectedPrefix: cyan,
	selectedText: bold,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
};

function oneLine(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolSummary(args: string): string {
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const first = ["command", "path", "pattern", "query", "url", "assignment"].find(
			(k) => typeof parsed[k] === "string",
		);
		return first ? oneLine(String(parsed[first])) : "";
	} catch {
		return oneLine(args);
	}
}

export async function runPiProto(): Promise<void> {
	const client = await ensureServerClient();
	if (!client) {
		console.error("cast: the pi-tui prototype needs the daemon (unset CAST_NO_DAEMON).");
		process.exit(1);
	}
	const sessionId = await createServerSession(client, { cwd: process.cwd() });

	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: "auto" });
	if (!isViewportTUI(tui)) throw new Error("expected the alternate-screen renderer");

	const transcript = new Container();
	const status = new Text(dim(`cast prototype · session ${sessionId}`), 1, 0);
	const editor = new Editor(tui, { borderColor: dim, selectList: selectListTheme }, { paddingX: 1 });

	// The live answer is one Markdown component that grows as tokens arrive.
	let live: Markdown | undefined;
	let liveText = "";
	const toolRows = new Map<string, Text>();
	let running = false;
	let startedAt = 0;
	let clock: NodeJS.Timeout | undefined;

	const add = (line: string) => {
		transcript.addChild(new Text(line, 1, 0));
		tui.requestRender();
	};
	const endLive = () => {
		live = undefined;
		liveText = "";
	};
	const paintStatus = () => {
		const state = running ? `working ${Math.floor((Date.now() - startedAt) / 1000)}s` : "idle";
		status.setText(dim(`${state} · session ${sessionId} · esc stops · ctrl+c quits`));
		tui.requestRender();
	};

	const onEvent = (event: AgentEvent | { type: string; [key: string]: unknown }) => {
		switch (event.type) {
			case "user_message": {
				const content = (event as { message?: { content?: unknown } }).message?.content;
				add(`${green("▌ you")}\n${typeof content === "string" ? content : "[attachment]"}`);
				break;
			}
			case "token": {
				liveText += (event as { text: string }).text;
				if (!live) {
					add(cyan("▌ agent"));
					live = new Markdown(liveText, 1, 0, markdownTheme);
					transcript.addChild(live);
				} else live.setText(liveText);
				tui.requestRender();
				break;
			}
			case "tool_start": {
				endLive();
				const e = event as { id: string; name: string; args: string };
				const row = new Text(dim(`│ ${e.name} ${toolSummary(e.args)}`), 1, 0);
				toolRows.set(e.id, row);
				transcript.addChild(row);
				tui.requestRender();
				break;
			}
			case "tool_end": {
				const e = event as { id: string; name: string; status: string };
				const row = toolRows.get(e.id);
				if (row && e.status === "error") row.setText(red(`✗ ${e.name}`));
				tui.requestRender();
				break;
			}
			case "status": {
				const next = (event as unknown as { status: string }).status === "running";
				if (next && !running) {
					startedAt = Date.now();
					clock = setInterval(paintStatus, 1000);
				}
				if (!next && clock) {
					clearInterval(clock);
					clock = undefined;
					endLive();
				}
				running = next;
				paintStatus();
				break;
			}
			case "error":
				add(red(`error: ${(event as { message?: string }).message ?? "unknown"}`));
				break;
			case "notice":
				add(dim(`[${(event as { message?: string }).message ?? ""}]`));
				break;
		}
	};

	subscribeServerEvents(
		client,
		sessionId,
		(event) => onEvent(event as never),
		() => false,
	);

	editor.onSubmit = (text) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		editor.setText("");
		void submitServerChat(client, sessionId, trimmed).catch((error: unknown) => {
			add(red(`submit failed: ${error instanceof Error ? error.message : String(error)}`));
		});
	};

	tui.setLayoutRoot(
		new VStack([
			{
				component: new ScrollView(transcript, {
					follow: "end",
					primary: true,
					overscroll: "chain",
					scrollbar: "auto",
				}),
				basis: 0,
				grow: 1,
				minSize: 1,
			},
			{ component: new VStack([editor, status]), basis: "auto", shrink: 1, minSize: 1 },
		]),
	);
	tui.setFocus(editor);

	const quit = () => {
		if (clock) clearInterval(clock);
		tui.stop();
		console.log(`Resume this session: cast --resume=${sessionId}`);
		process.exit(0);
	};
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			quit();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && running) {
			void abortServerSession(client, sessionId).catch(() => {});
			return { consume: true };
		}
		return undefined;
	});

	tui.start();
	paintStatus();
}
