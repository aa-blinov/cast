import { Box, Text, useInput } from "ink";
import { type JSX, useState } from "react";
import type { StatusBarConfig } from "../core/settings.ts";
import type { StatusBarSegment } from "./statusbar.tsx";
import { theme } from "./themes/index.ts";

interface Item {
	id: string;
	side: "left" | "right";
	visible: boolean;
}

interface StatusBarPickerProps {
	segments: readonly StatusBarSegment[];
	initialConfig: StatusBarConfig;
	onConfirm: (config: StatusBarConfig) => void;
	onCancel: () => void;
}

function configToItems(segments: readonly StatusBarSegment[], config: StatusBarConfig): Item[] {
	const visibleSet = new Set(config.visible);
	const order = config.order.length > 0 ? config.order : segments.map((s) => s.id);
	const items: Item[] = [];
	for (const id of order) {
		const seg = segments.find((s) => s.id === id);
		if (!seg) continue;
		items.push({ id, side: config.sides[id] ?? seg.side, visible: visibleSet.has(id) });
	}
	// Append any segments not in order (newly registered)
	for (const seg of segments) {
		if (!items.some((i) => i.id === seg.id)) {
			items.push({ id: seg.id, side: seg.side, visible: seg.defaultOn });
		}
	}
	return items;
}

function itemsToDisplayOrder(items: Item[]): Item[] {
	const left = items.filter((i) => i.side === "left");
	const right = items.filter((i) => i.side === "right");
	return [...left, ...right];
}

export function StatusBarPicker(props: StatusBarPickerProps): JSX.Element {
	const { segments, onConfirm, onCancel } = props;
	const [items, setItems] = useState<Item[]>(() => itemsToDisplayOrder(configToItems(segments, props.initialConfig)));
	const [cursor, setCursor] = useState(0);

	useInput((input, key) => {
		if (key.upArrow) {
			setCursor((c) => (c - 1 + items.length) % items.length);
			return;
		}
		if (key.downArrow) {
			setCursor((c) => (c + 1) % items.length);
			return;
		}
		if (input === " ") {
			setItems((prev) => {
				const next = [...prev];
				const item = next[cursor]!;
				next[cursor] = { ...item, visible: !item.visible };
				return next;
			});
			return;
		}
		if (key.leftArrow) {
			// Move to left side — insert after last left item
			setItems((prev) => {
				const item = prev[cursor]!;
				if (item.side === "left") return prev;
				const without = prev.filter((_, i) => i !== cursor);
				let lastLeftIdx = -1;
				for (let i = 0; i < without.length; i++) {
					if (without[i]!.side === "left") lastLeftIdx = i;
				}
				const next = [...without];
				const insertAt = lastLeftIdx + 1;
				next.splice(insertAt, 0, { ...item, side: "left" });
				setCursor(insertAt);
				return next;
			});
			return;
		}
		if (key.rightArrow) {
			// Move to right side — insert after last right item (or at end)
			setItems((prev) => {
				const item = prev[cursor]!;
				if (item.side === "right") return prev;
				const without = prev.filter((_, i) => i !== cursor);
				let lastRightIdx = -1;
				for (let i = 0; i < without.length; i++) {
					if (without[i]!.side === "right") lastRightIdx = i;
				}
				const insertAt = lastRightIdx >= 0 ? lastRightIdx + 1 : without.length;
				const next = [...without];
				next.splice(insertAt, 0, { ...item, side: "right" });
				setCursor(insertAt);
				return next;
			});
			return;
		}
		if (input === "j" || input === "J") {
			// Reorder down within current side
			setItems((prev) => {
				const item = prev[cursor]!;
				const sameSide = prev.filter((i) => i.side === item.side);
				const posInSide = sameSide.indexOf(item);
				if (posInSide >= sameSide.length - 1) return prev; // already last
				// Find the next same-side item in the full list
				for (let i = cursor + 1; i < prev.length; i++) {
					if (prev[i]!.side === item.side) {
						const next = [...prev];
						[next[cursor], next[i]] = [next[i]!, next[cursor]!];
						setCursor(i);
						return next;
					}
				}
				return prev;
			});
			return;
		}
		if (input === "k" || input === "K") {
			// Reorder up within current side
			setItems((prev) => {
				const item = prev[cursor]!;
				const sameSide = prev.filter((i) => i.side === item.side);
				const posInSide = sameSide.indexOf(item);
				if (posInSide <= 0) return prev; // already first
				for (let i = cursor - 1; i >= 0; i--) {
					if (prev[i]!.side === item.side) {
						const next = [...prev];
						[next[cursor], next[i]] = [next[i]!, next[cursor]!];
						setCursor(i);
						return next;
					}
				}
				return prev;
			});
			return;
		}
		if (key.return) {
			const visible = items.filter((i) => i.visible).map((i) => i.id);
			const order = items.map((i) => i.id);
			const sides: Record<string, "left" | "right"> = {};
			for (const item of items) sides[item.id] = item.side;
			onConfirm({ visible, order, sides });
			return;
		}
		if (key.escape || input === "q") {
			onCancel();
		}
	});

	const segMap = new Map(segments.map((s) => [s.id, s]));
	const leftCount = items.filter((i) => i.side === "left").length;

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color={theme().accent}>
				Status bar segments
			</Text>
			{items.map((item, i) => {
				const seg = segMap.get(item.id);
				if (!seg) return null;
				const focused = i === cursor;
				const showSep = item.side === "right" && i === leftCount && leftCount > 0 && items.length > leftCount;
				return (
					<Box key={item.id} flexDirection="column">
						{showSep && (
							<Text color={theme().muted} dimColor>
								{"  "}
								{"─".repeat(30)}
							</Text>
						)}
						<Text wrap="truncate">
							<Text color={focused ? theme().accent : theme().muted}>{focused ? ">" : " "}</Text>{" "}
							<Text color={focused ? theme().accent : "white"} bold={focused}>
								{item.visible ? "[x]" : "[ ]"}
							</Text>{" "}
							<Text color={theme().muted} dimColor>
								{item.side === "left" ? "Left " : "Right"}
							</Text>
							<Text color={theme().muted}> │ </Text>
							<Text color={focused ? theme().accent : "white"} bold={focused}>
								{seg.label}
							</Text>
						</Text>
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text color={theme().muted}>
					↑/↓ navigate · Space toggle · ←/→ side · j/k reorder · Enter confirm · Esc cancel
				</Text>
			</Box>
		</Box>
	);
}
