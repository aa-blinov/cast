import { Box, Text, useApp, useWindowSize } from "ink";
import { type JSX, useCallback, useEffect, useState } from "react";
import { type AppConfig, inputTokenBudget } from "../core/config.ts";
import { countTurnMessages, estimateTokens } from "../core/session.ts";
import type { StatusBarConfig } from "../core/settings.ts";
import type { StartupResult } from "../core/startup.ts";
import { setSuspendHook } from "../core/stdin-manager.ts";
import { ModalPicker, MultiSelectPicker, TextInputModal } from "../pickers/ink.tsx";
import { useAnimationTick } from "./animation-clock.ts";
import { useAppModel } from "./app-model.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { displayWidth } from "./display-width.ts";
import { LiveViewer } from "./live-viewer.tsx";
import type { ClipboardPasteResult } from "./readClipboardImage.ts";
import { Spinner } from "./Spinner.tsx";
import { fitSegments, getStatusBarSegments, type SegmentContext, type StatusBarSegment } from "./statusbar.tsx";
import { StatusBarPicker } from "./statusbar-picker.tsx";
import { theme } from "./themes/index.ts";
import { useTerminalResync } from "./useTerminalResync.ts";
import { useWorkingTitle } from "./working-title.ts";

const TRAILING_ZERO_RE = /\.0$/;

interface AppProps {
	result: StartupResult;
	version: string;
	initialPrompt?: string;
	onPasteImage?: () => Promise<ClipboardPasteResult>;
	onQuit: () => void;
	onClearScreen?: (preserveScrollback?: boolean) => Promise<void>;
	/** When set, the TUI runs as a thin client of the `cast server` daemon
	 *  (single-writer model) instead of owning runAgentLoop locally. */
	daemonUrl?: string;
	daemonToken?: string;
}

export function App(props: AppProps): JSX.Element {
	const { result, version, initialPrompt, onPasteImage, onQuit, onClearScreen, daemonUrl, daemonToken } = props;

	// Wire Ink's suspendTerminal so execBash can hand the terminal to child
	// processes (live output, password prompts). Done here via the public
	// useApp() hook — the previous wiring in tui.tsx resolved ink's internal
	// instances.js at runtime, which worked in dev but always failed in the
	// release bundle (ink is inlined by esbuild, there's no node_modules/ink
	// to resolve against), silently leaving live bash output to interleave
	// with Ink's frames and stack duplicated composer/status lines.
	const { suspendTerminal, waitUntilRenderFlush } = useApp();
	useEffect(() => {
		setSuspendHook(async (cb) => {
			await suspendTerminal(cb);
		});
	}, [suspendTerminal]);

	// Resize/reflow, terminal-scroll, and focus-return desyncs all need a
	// screen clear + full <Static> replay — see useTerminalResync for why.
	// Two tiers: resize and focus-regain use a light clear (\x1b[2J only,
	// no scrollback wipe) so the user's scroll position survives; theme
	// changes do a full clear (\x1b[2J\x1b[3J) because the banner gradient
	// changed and the old copy in scrollback must disappear.
	const [repaintKey, setRepaintKey] = useState(0);
	useTerminalResync(
		useCallback(
			async (preserveScrollback: boolean) => {
				await onClearScreen?.(preserveScrollback);
				setRepaintKey((k) => k + 1);
				// The synchronized-output block useTerminalResync wraps this call
				// in must stay open until the replayed <Static> content actually
				// reaches the terminal — closing it right after the setRepaintKey
				// call above (which only *schedules* the re-render) would swap in
				// the cleared-but-not-yet-redrawn screen. waitUntilRenderFlush is
				// Ink's own signal for "pending render output is flushed to
				// stdout" (it also settles Ink's internal render throttle), so
				// awaiting it here is the real fix for the setImmediate guess
				// that used to gate the release.
				await waitUntilRenderFlush();
			},
			[onClearScreen, waitUntilRenderFlush],
		),
	);

	// Theme change counter — forces a re-render when /theme switches the active
	// theme, since theme() reads from a module-level singleton that Ink can't
	// detect on its own.
	const [_themeVer, setThemeVer] = useState(0);
	const onThemeChange = useCallback(() => {
		// Order matters: clear the screen and the scrollback first, and only
		// then bump the version so the <Static> key change replays the
		// recoloured history from a clean top. Bumping first would append a
		// second copy of the transcript under the old one.
		void (async () => {
			await onClearScreen?.();
			setThemeVer((v) => v + 1);
		})();
	}, [onClearScreen]);
	// History was prepended by /older (loadOlder shifts every <Static> index,
	// which that component never revisits) — replay the whole transcript from a
	// clean top, same clear + key-bump contract as a theme change.
	const onRepaintHistory = useCallback(() => {
		void (async () => {
			await onClearScreen?.();
			setRepaintKey((k) => k + 1);
		})();
	}, [onClearScreen]);

	const {
		agent,
		notice,
		modalRequest,
		session,
		cwd,
		skills,
		running,
		statusBar,
		currentPersona,
		planMode,
		activeModel,
		planModel,
		config,
		lspServers,
		promptHistory,
		canSubmit,
		handleSubmit,
		onLoadOlder,
	} = useAppModel({ result, version, initialPrompt, onQuit, onThemeChange, onRepaintHistory, daemonUrl, daemonToken });

	return (
		<Box flexDirection="column">
			<ChatLogWithSize
				messages={agent.messages}
				streaming={agent.streaming}
				error={agent.error}
				retry={agent.retry}
				showReasoning={agent.showReasoning}
				repaintKey={repaintKey + _themeVer}
			/>
			{notice && <Text color={theme().warning}>{notice}</Text>}
			{modalRequest?.kind === "option" && (
				<ModalPicker
					options={modalRequest.options}
					opts={modalRequest.opts}
					onSelect={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{modalRequest?.kind === "text" && (
				<TextInputModal
					label={modalRequest.label}
					defaultValue={modalRequest.defaultValue}
					placeholder={modalRequest.placeholder}
					error={modalRequest.error}
					onSubmit={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{modalRequest?.kind === "multi" && (
				<MultiSelectPicker
					options={modalRequest.options}
					opts={modalRequest.opts}
					initialSelected={modalRequest.initialSelected}
					onConfirm={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{modalRequest?.kind === "status" && (
				<Box>
					<Spinner />
					<Text> {modalRequest.label}</Text>
				</Box>
			)}
			{modalRequest?.kind === "view" && <LiveViewer view={modalRequest.view} onClose={modalRequest.resolve} />}
			{modalRequest?.kind === "statusbar" && (
				<StatusBarPicker
					segments={modalRequest.segments}
					initialConfig={modalRequest.initialConfig}
					onConfirm={modalRequest.resolve}
					onCancel={() => modalRequest.resolve(null)}
				/>
			)}
			{/* Stays up for as long as the message is actually queued — not a
			    timed toast, since a tool-heavy turn can take much longer than a
			    fixed timeout to reach the point where the queue gets drained. */}
			<PendingRows label="Steer queued" items={agent.pendingSteers} />
			<PendingRows label="Queued" items={agent.pendingQueue} />
			<ComposerDivider />
			<Composer
				onSubmit={(text) => handleSubmit(text)}
				canSubmit={canSubmit}
				onAbort={agent.abort}
				onExit={onQuit}
				onPasteImage={onPasteImage}
				onLoadOlder={() => void onLoadOlder()}
				promptHistory={promptHistory}
				sessionId={session.id}
				running={running}
				locked={modalRequest !== null}
				cwd={cwd}
				skills={skills}
			/>
			<ComposerDivider />
			<StatusBar
				statusBar={statusBar}
				persona={currentPersona.label}
				planMode={planMode}
				activeModel={activeModel}
				configuredModel={session.model}
				planModel={planModel}
				usage={agent.usage ?? undefined}
				lastTurnUsage={agent.lastTurnUsage ?? undefined}
				turnStartedAt={agent.turnStartedAt}
				getElapsedMs={agent.getElapsedMs}
				messageCount={countTurnMessages(session.messages)}
				contextWindow={config.contextWindow}
				maxResponseTokens={config.maxResponseTokens}
				messages={session.messages}
				sessionId={session.id}
				worktree={cwd.includes("/.cast/worktrees/") ? cwd.split("/.cast/worktrees/")[1]?.split("/")[0] : undefined}
				lspServers={lspServers}
				repaintKey={repaintKey}
			/>
		</Box>
	);
}

/**
 * One row per pending /steer or /queue message, truncated — never wrapped,
 * and never more rows than this.
 *
 * A queued prompt is as long as the user made it. Rendered in full it pushed
 * the live region past the terminal height, and Ink answers that by clearing
 * the screen *and the scrollback* on every frame: two long /queue messages
 * during a streaming answer measured 210 full clears and 1.8MB of output,
 * with the scroll position gone. The full text is still in the queue (and
 * lands in the transcript when it's sent) — this row is only a receipt.
 */
const MAX_PENDING_ROWS = 3;

function PendingRows({ label, items }: { label: string; items: string[] }): JSX.Element | null {
	if (items.length === 0) return null;
	return (
		<>
			{items.slice(0, MAX_PENDING_ROWS).map((text, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: FIFO queue, no stable identity
				<Text key={`${label}-${i}`} color={theme().warning} wrap="truncate">
					[{label}
					{items.length > 1 ? ` (${i + 1}/${items.length})` : ""}: {text}]
				</Text>
			))}
			{items.length > MAX_PENDING_ROWS && (
				<Text color={theme().warning}>[+{items.length - MAX_PENDING_ROWS} more queued]</Text>
			)}
		</>
	);
}

/**
 * Status bar, in its own component so its elapsed-time tick doesn't force
 * App (and Composer under it) to re-render every 200ms. `turnStartedAt`
 * only changes at turn start/stop; the live "Xs" display ticks off a local
 * interval scoped to this component instead of a state update in
 * useAgentSession (which lives in App's own fiber).
 */
function StatusBar(
	props: Omit<SegmentContext, "elapsedMs"> & {
		statusBar: StatusBarConfig;
		turnStartedAt: number | null;
		getElapsedMs: () => number;
		repaintKey: number;
	},
): JSX.Element {
	const { statusBar, turnStartedAt, getElapsedMs, repaintKey, ...ctxRest } = props;
	// On the spinners' clock: its own 100ms timer made a frame of its own.
	useAnimationTick(turnStartedAt !== null);
	useWorkingTitle(turnStartedAt);

	const ctx: SegmentContext = { ...ctxRest, elapsedMs: getElapsedMs() };
	const { columns } = useWindowSize();
	const segments = getStatusBarSegments();
	const visibleSet = new Set(statusBar.visible);

	// Build ordered list from statusBar.order, then append any new segments
	const ordered: StatusBarSegment[] = statusBar.order
		.map((id) => segments.find((s) => s.id === id))
		.filter(Boolean) as StatusBarSegment[];
	for (const seg of segments) {
		if (!ordered.some((s) => s.id === seg.id)) ordered.push(seg);
	}

	const shown = ordered.flatMap((seg) => {
		if (!visibleSet.has(seg.id)) return [];
		const node = seg.render(ctx);
		if (!node) return [];
		const side: "left" | "right" = statusBar.sides[seg.id] ?? seg.side;
		return [{ id: seg.id, side, node, text: seg.formatValue(ctx) ?? "" }];
	});
	const leftElems: JSX.Element[] = [];
	const rightElems: JSX.Element[] = [];
	for (const item of fitSegments(shown, columns, displayWidth)) {
		(item.side === "left" ? leftElems : rightElems).push(item.node);
	}

	const sep = <Text color={theme().muted}> │ </Text>;
	const renderGroup = (elems: JSX.Element[]) => elems.flatMap((el, i) => (i > 0 ? [sep, el] : [el]));

	// Both groups truncate, and the right one keeps its width: without that the
	// bar wrapped to two rows on a 24-column terminal (growing the live region,
	// which has to stay a fixed height) and the elapsed counter painted over
	// the tail of the model name at 40 — `test-model` read `test-mode0.4s`.
	return (
		<Box justifyContent="space-between">
			<Text color={theme().muted} dimColor wrap="truncate">
				{...renderGroup(leftElems)}
				{repaintKey % 2 === 1 ? "\u200b" : null}
			</Text>
			{rightElems.length > 0 && (
				<Box flexShrink={0}>
					<Text color={theme().muted} dimColor wrap="truncate">
						{...renderGroup(rightElems)}
					</Text>
				</Box>
			)}
		</Box>
	);
}

/**
 * Isolates the useWindowSize() subscription so its re-renders stay scoped to
 * ChatLog instead of bubbling up to App (and Composer with it) — React only
 * re-renders this component's own subtree on its state changes, not its
 * ancestors, so calling the hook here rather than in App keeps every resize
 * tick from also re-rendering the composer.
 *
 * Deliberately NOT debounced: Ink's own resize handling re-wraps the real
 * text immediately, synchronously, without waiting on anything (see
 * ink.js's `resized()`). Feeding clampStreamingBlocks a stale (debounced)
 * width would judge the live region's wrap by the *previous* terminal width
 * for a beat after Ink had already re-wrapped at the new one. Re-rendering
 * ChatLog every tick is the correct tradeoff here: it's isolated from
 * Composer regardless, and Ink's own maxFps throttle still caps how often
 * that actually reaches the terminal.
 */
function ChatLogWithSize(props: Omit<Parameters<typeof ChatLog>[0], "columns">): JSX.Element {
	const { columns } = useWindowSize();
	return <ChatLog {...props} columns={columns} />;
}

/** Thin divider between the transcript and the composer — a plain ruled line
 *  that spans the terminal width. Kept border-free so it can never tear like
 *  the old composer box. */
function ComposerDivider(): JSX.Element {
	const { columns } = useWindowSize();
	// Full width: the old `columns - 1` left a gap at the right edge that read
	// as a rendering bug on a narrow terminal. Ink measures the row itself and
	// emits its own newline, so a row exactly as wide as the terminal does not
	// wrap — verified at 24, 40 and 120 columns.
	return (
		<Box>
			<Text color={theme().muted}>{"─".repeat(Math.max(columns, 20))}</Text>
		</Box>
	);
}

/**
 * Compact token count for the status line: 736 stays, 8,736 → "8.7k",
 * 1,200,000 → "1.2M". One decimal, trailing ".0" dropped (8,000 → "8k").
 * Under the composer the exact digits don't matter — the magnitude does — and
 * the short form keeps the line from wrapping.
 */
export function abbreviateTokens(n: number): string {
	if (n < 1000) return String(n);
	// 999,950+ would round to "1000.0k" — hand those to the M branch so it reads
	// "1M" instead.
	if (n < 999_950) return `${(n / 1000).toFixed(1).replace(TRAILING_ZERO_RE, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(TRAILING_ZERO_RE, "")}M`;
}

export function formatContextPct(messages: import("../core/llm.ts").Message[], config: AppConfig): string {
	const used = estimateTokens(messages);
	if (!(config.contextWindow > 0)) return "ctx ?";
	const budget = inputTokenBudget(config);
	const pct = Math.round((used / budget) * 100);
	return `ctx ${abbreviateTokens(used)}/${abbreviateTokens(budget)} (${pct}%)`;
}
