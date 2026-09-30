import { Box, Text, useInput, useStdout } from "ink";
import { type JSX, useEffect, useState } from "react";
import type { LiveView } from "../pickers/types.ts";
import { theme } from "./themes/index.ts";

const POLL_MS = 1000;
// Rows the rest of the screen keeps: composer, status bar and this modal's own chrome.
const CHROME_ROWS = 12;

/** The `rows` lines that end `fromBottom` lines above the last one. */
export function windowLines(lines: string[], rows: number, fromBottom: number): string[] {
	const end = Math.max(rows, lines.length - fromBottom);
	return lines.slice(Math.max(0, end - rows), end);
}

interface LiveViewerProps {
	view: LiveView;
	onClose: () => void;
}

export function LiveViewer({ view, onClose }: LiveViewerProps): JSX.Element {
	const { stdout } = useStdout();
	const rows = Math.max(6, (stdout?.rows ?? 30) - CHROME_ROWS);
	const [snapshot, setSnapshot] = useState(() => view.read());
	// Lines above the bottom; 0 follows the newest output.
	const [fromBottom, setFromBottom] = useState(0);
	const [stopped, setStopped] = useState(false);

	useEffect(() => {
		const timer = setInterval(() => setSnapshot(view.read()), POLL_MS);
		return () => clearInterval(timer);
	}, [view]);

	const lines = snapshot.text.split("\n");
	const maxBack = Math.max(0, lines.length - rows);

	useInput((input, key) => {
		if (key.escape || key.leftArrow || input === "q") {
			onClose();
		} else if (key.upArrow) {
			setFromBottom((n) => Math.min(maxBack, n + 1));
		} else if (key.downArrow) {
			setFromBottom((n) => Math.max(0, n - 1));
		} else if (key.pageUp) {
			setFromBottom((n) => Math.min(maxBack, n + rows));
		} else if (key.pageDown) {
			setFromBottom((n) => Math.max(0, n - rows));
		} else if (input === "s" && snapshot.running && view.stop && !stopped) {
			setStopped(true);
			void Promise.resolve(view.stop()).catch(() => {});
		}
	});

	const shown = windowLines(lines, rows, Math.min(fromBottom, maxBack));
	const canStop = snapshot.running && view.stop !== undefined && !stopped;
	return (
		<Box flexDirection="column" paddingX={1}>
			<Text bold color={theme().accent}>
				{view.title} {snapshot.running ? (stopped ? "· stopping…" : "· running") : "· finished"}
			</Text>
			{shown.map((line, i) => (
				// The window slides, so the position is the only stable identity a line has.
				// biome-ignore lint/suspicious/noArrayIndexKey: see above
				<Text key={i} wrap="truncate-end">
					{line || " "}
				</Text>
			))}
			<Text color={theme().muted} dimColor>
				{fromBottom > 0 ? `${Math.min(fromBottom, maxBack)} lines below · ` : ""}esc back · ↑↓ PgUp/PgDn scroll
				{canStop ? " · s stop it" : ""}
			</Text>
		</Box>
	);
}
