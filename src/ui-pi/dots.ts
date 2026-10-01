/** One step of the loader every 400ms. */
const STEP_MS = 400;
const TRAILING_DOTS_RE = /(\.{2,}|…)\s*$/;

/** `.`, `..`, `...` in turn, padded to three cells so what sits beside them does not move. */
export function dots(now = Date.now()): string {
	return ".".repeat((Math.floor(now / STEP_MS) % 3) + 1).padEnd(3);
}

/** A label without the dots it was written with ("Loading models..." and "Loading models…" both become "Loading models"). */
export function withoutDots(label: string): string {
	return label.replace(TRAILING_DOTS_RE, "");
}
