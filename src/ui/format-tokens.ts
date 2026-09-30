const TRAILING_ZERO_RE = /\.0$/;

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
