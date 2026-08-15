import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

// Chart.js is vendored at /vendor/chart.umd.min.js and loaded lazily on first
// open, so the dashboard never pays for it unless it's actually used.
let chartPromise = null;
function loadChart() {
	if (window.Chart) return Promise.resolve(window.Chart);
	if (!chartPromise) {
		chartPromise = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = "/vendor/chart.umd.min.js";
			script.onload = () => resolve(window.Chart);
			script.onerror = () => reject(new Error("Failed to load Chart.js"));
			document.head.appendChild(script);
		});
	}
	return chartPromise;
}

// Read the active theme's colors from the root CSS variables (app.js applies
// them on document.documentElement) so every chart matches the selected theme.
function themeColors() {
	const s = getComputedStyle(document.documentElement);
	const c = (name, fallback) => {
		const v = s.getPropertyValue(name).trim();
		return v || fallback;
	};
	return {
		border: c("--border", "#2d2b31"),
		textMuted: c("--text-muted", "#9ca3af"),
		cyan: c("--cyan", "#22d3ee"),
		violet: c("--violet", "#a78bfa"),
		teal: c("--teal", "#34d399"),
		amber: c("--amber", "#fbbf24"),
		rose: c("--rose", "#f87171"),
	};
}

const fmtTokens = (n) => {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
};

const fmtMs = (ms) => {
	if (ms == null) return "—";
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
	return `${Math.round(ms)}ms`;
};

const fmtCost = (n) => (n ? `$${n.toFixed(4)}` : "—");

function timeLabel(ts, coarse) {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return coarse ? `${d.getMonth() + 1}/${d.getDate()} ${hh}:00` : `${hh}:${mm}`;
}

function makeBaseOptions(colors) {
	return {
		responsive: true,
		maintainAspectRatio: false,
		animation: false,
		plugins: {
			legend: {
				labels: { color: colors.textMuted, boxWidth: 10, boxHeight: 10, font: { size: 11 } },
			},
		},
		scales: {
			x: {
				ticks: { color: colors.textMuted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 10 } },
				grid: { color: colors.border },
			},
			y: { ticks: { color: colors.textMuted, font: { size: 10 } }, grid: { color: colors.border } },
		},
	};
}

function KpiCard({ label, value, sub, tone }) {
	return html`<div class="dash-kpi${tone ? ` dash-kpi-${tone}` : ""}">
		<div class="dash-kpi-label">${label}</div>
		<div class="dash-kpi-value">${value}</div>
		${sub ? html`<div class="dash-kpi-sub">${sub}</div>` : null}
	</div>`;
}

export function Dashboard({ onClose }) {
	const [tab, setTab] = useState("llm");
	const [range, setRange] = useState("24h");
	const [llm, setLlm] = useState({ overview: [], series: [], recent: [] });
	const [perf, setPerf] = useState({ overview: [], series: [] });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [themeVersion, setThemeVersion] = useState(0);
	const chartsRef = useRef({});
	const requestIdRef = useRef(0);

	// Watch the root style for theme changes (applyTheme mutates
	// document.documentElement) and bump themeVersion so charts re-color.
	useEffect(() => {
		const observer = new MutationObserver(() => setThemeVersion((v) => v + 1));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
		return () => observer.disconnect();
	}, []);

	const destroyCharts = useCallback(() => {
		for (const key of Object.keys(chartsRef.current)) {
			chartsRef.current[key]?.destroy?.();
			delete chartsRef.current[key];
		}
	}, []);

	const load = useCallback(async () => {
		const req = ++requestIdRef.current;
		const hours = range === "30d" ? 720 : range === "7d" ? 168 : 24;
		const resolution = hours === 24 ? 60 : hours === 168 ? 360 : 1440;
		setLoading(true);
		setError(null);
		try {
			const [ov, se, rec, eo, es] = await Promise.all([
				api("GET", `/api/telemetry/overview?since=${hours}`),
				api("GET", `/api/telemetry/series?since=${hours}&resolution=${resolution}`),
				api("GET", `/api/telemetry/recent?limit=50`),
				api("GET", `/api/telemetry/endpoints?since=${hours}`),
				api("GET", `/api/telemetry/endpoint-series?since=${hours}&resolution=${resolution}`),
			]);
			if (req !== requestIdRef.current) return;
			setLlm({ overview: ov?.rows ?? [], series: se?.buckets ?? [], recent: rec?.rows ?? [] });
			setPerf({ overview: eo?.rows ?? [], series: es?.buckets ?? [] });
		} catch (err) {
			if (req === requestIdRef.current) setError(err.message);
		} finally {
			if (req === requestIdRef.current) setLoading(false);
		}
	}, [range]);

	useEffect(() => {
		load();
	}, [load]);

	// Create/refresh charts once Chart.js is ready and the active tab's data
	// is present. Re-reads theme colors every time so a theme change re-colors.
	useEffect(() => {
		if (loading) return;
		const data = tab === "llm" ? llm : perf;
		if (data.series.length === 0) return;
		let cancelled = false;
		loadChart()
			.then((Chart) => {
				if (cancelled) return;
				destroyCharts();
				const colors = themeColors();
				const coarse = range !== "24h";
				const labels = data.series.map((b) => timeLabel(b.ts, coarse));
				if (tab === "llm") {
					chartsRef.current["requests"] = new Chart(document.getElementById("dash-chart-requests"), {
						type: "line",
						data: {
							labels,
							datasets: [
								{ label: "requests", data: data.series.map((b) => b.requests), borderColor: colors.cyan, backgroundColor: colors.cyan, yAxisID: "y", pointRadius: 0, borderWidth: 2 },
								{ label: "avg latency ms", data: data.series.map((b) => b.avgLatencyMs ?? null), borderColor: colors.amber, backgroundColor: colors.amber, yAxisID: "y1", pointRadius: 0, borderWidth: 1, borderDash: [4, 4] },
							],
						},
						options: {
							...makeBaseOptions(colors),
							scales: {
								x: makeBaseOptions(colors).scales.x,
								y: { ...makeBaseOptions(colors).scales.y, position: "left", title: { display: true, text: "requests", color: colors.textMuted } },
								y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: colors.textMuted, font: { size: 10 } }, title: { display: true, text: "ms", color: colors.textMuted } },
							},
						},
					});
					chartsRef.current["tokens"] = new Chart(document.getElementById("dash-chart-tokens"), {
						type: "line",
						data: {
							labels,
							datasets: [
								{ label: "prompt tokens", data: data.series.map((b) => b.promptTokens), borderColor: colors.teal, backgroundColor: colors.teal, pointRadius: 0, borderWidth: 2 },
								{ label: "completion tokens", data: data.series.map((b) => b.completionTokens), borderColor: colors.violet, backgroundColor: colors.violet, pointRadius: 0, borderWidth: 2 },
							],
						},
						options: makeBaseOptions(colors),
					});
					chartsRef.current["providers"] = new Chart(document.getElementById("dash-chart-providers"), {
						type: "bar",
						data: {
							labels: llm.overview.map((r) => `${r.provider}/${r.model}`),
							datasets: [
								{ label: "prompt tokens", data: llm.overview.map((r) => r.promptTokens), backgroundColor: colors.cyan },
								{ label: "cost", data: llm.overview.map((r) => r.cost), backgroundColor: colors.amber, yAxisID: "y1" },
							],
						},
						options: {
							...makeBaseOptions(colors),
							scales: {
								x: { ...makeBaseOptions(colors).scales.x, ticks: { ...makeBaseOptions(colors).scales.x.ticks, maxRotation: 45 } },
								y: { ...makeBaseOptions(colors).scales.y, title: { display: true, text: "tokens", color: colors.textMuted } },
								y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: colors.textMuted, font: { size: 10 } }, title: { display: true, text: "$", color: colors.textMuted } },
							},
						},
					});
				} else {
					chartsRef.current["endpoints"] = new Chart(document.getElementById("dash-chart-endpoints"), {
						type: "line",
						data: {
							labels,
							datasets: [
								{ label: "requests", data: data.series.map((b) => b.requests), borderColor: colors.cyan, backgroundColor: colors.cyan, yAxisID: "y", pointRadius: 0, borderWidth: 2 },
								{ label: "avg latency ms", data: data.series.map((b) => b.avgLatencyMs ?? null), borderColor: colors.amber, backgroundColor: colors.amber, yAxisID: "y1", pointRadius: 0, borderWidth: 1, borderDash: [4, 4] },
							],
						},
						options: {
							...makeBaseOptions(colors),
							scales: {
								x: makeBaseOptions(colors).scales.x,
								y: { ...makeBaseOptions(colors).scales.y, position: "left", title: { display: true, text: "requests", color: colors.textMuted } },
								y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: colors.textMuted, font: { size: 10 } }, title: { display: true, text: "ms", color: colors.textMuted } },
							},
						},
					});
				}
			})
			.catch((err) => setError(err.message));
		return () => {
			cancelled = true;
		};
	}, [loading, tab, llm, perf, range, themeVersion, destroyCharts]);

	const llmTotals = llm.overview.reduce(
		(acc, r) => {
			acc.requests += r.requests;
			acc.prompt += r.promptTokens;
			acc.completion += r.completionTokens;
			acc.cacheRead += r.cacheReadTokens;
			acc.cost += r.cost;
			acc.errors += r.errors;
			if (r.avgLatencyMs != null) acc.latencies.push(r.avgLatencyMs);
			return acc;
		},
		{ requests: 0, prompt: 0, completion: 0, cacheRead: 0, cost: 0, errors: 0, latencies: [] },
	);
	const llmCacheRate = llmTotals.prompt > 0 ? Math.round((llmTotals.cacheRead / llmTotals.prompt) * 100) : null;
	const llmAvgLatency =
		llmTotals.latencies.length > 0 ? llmTotals.latencies.reduce((a, b) => a + b, 0) / llmTotals.latencies.length : null;

	const perfTotals = perf.overview.reduce(
		(acc, r) => {
			acc.requests += r.requests;
			acc.errors += r.errors;
			if (r.avgLatencyMs != null) {
				acc.latencies.push(r.avgLatencyMs);
				if (r.maxLatencyMs != null && r.maxLatencyMs > acc.max) acc.max = r.maxLatencyMs;
			}
			return acc;
		},
		{ requests: 0, errors: 0, latencies: [], max: 0 },
	);
	const perfAvgLatency =
		perfTotals.latencies.length > 0 ? perfTotals.latencies.reduce((a, b) => a + b, 0) / perfTotals.latencies.length : null;

	const now = Date.now();
	const rangeMs = range === "30d" ? 720 : range === "7d" ? 168 : 24;
	const recentView = llm.recent.filter((r) => now - r.ts < rangeMs * 60 * 60 * 1000).slice(0, 30);
	const rangeLabel = range === "30d" ? "30 days" : range === "7d" ? "7 days" : "24 hours";

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal dash-modal" role="dialog" aria-modal="true" aria-label="Dashboard" tabIndex="-1" onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span class="dash-title">Dashboard</span>
					<div class="dash-tabs">
						<button class="modal-btn${tab === "llm" ? " modal-btn-primary" : ""}" onClick=${() => setTab("llm")}>LLM</button>
						<button class="modal-btn${tab === "perf" ? " modal-btn-primary" : ""}" onClick=${() => setTab("perf")}>Performance</button>
					</div>
					<div class="dash-range">
						<button class="modal-btn${range === "24h" ? " modal-btn-primary" : ""}" onClick=${() => setRange("24h")}>24h</button>
						<button class="modal-btn${range === "7d" ? " modal-btn-primary" : ""}" onClick=${() => setRange("7d")}>7d</button>
						<button class="modal-btn${range === "30d" ? " modal-btn-primary" : ""}" onClick=${() => setRange("30d")}>30d</button>
					</div>
					<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="dash-body">
					${error ? html`<div class="dash-error">${error}</div>` : null}
					${loading ? html`<div class="dash-loading"><span class="dash-spinner" /> Loading…</div>` : null}

			${tab === "llm"
				? html`
					<div class="dash-kpis">
						<${KpiCard} label="Requests" value=${fmtTokens(llmTotals.requests)} sub=${rangeLabel} />
						<${KpiCard} label="Prompt tokens" value=${fmtTokens(llmTotals.prompt)} />
						<${KpiCard} label="Completion tokens" value=${fmtTokens(llmTotals.completion)} />
						<${KpiCard} label="Cost" value=${fmtCost(llmTotals.cost)} />
						<${KpiCard} label="Cache rate" value=${llmCacheRate == null ? "—" : `${llmCacheRate}%`} tone=${llmCacheRate != null && llmCacheRate >= 80 ? "ok" : ""} />
						<${KpiCard} label="Avg latency" value=${fmtMs(llmAvgLatency)} />
						<${KpiCard} label="Errors" value=${llmTotals.errors} tone=${llmTotals.errors > 0 ? "err" : ""} />
					</div>
					<div class="dash-charts">
						<div class="dash-chart-box"><div class="dash-chart-title">Requests & latency</div><div class="dash-chart"><canvas id="dash-chart-requests" /></div></div>
						<div class="dash-chart-box"><div class="dash-chart-title">Tokens</div><div class="dash-chart"><canvas id="dash-chart-tokens" /></div></div>
						<div class="dash-chart-box dash-chart-box-wide"><div class="dash-chart-title">By provider & model</div><div class="dash-chart"><canvas id="dash-chart-providers" /></div></div>
					</div>
					<div class="dash-section-title">Recent requests</div>
					<div class="dash-table-wrap">
						<table class="dash-table">
							<thead><tr><th>Time</th><th>Kind</th><th>Provider</th><th>Model</th><th>In</th><th>Out</th><th>Cache</th><th>Latency</th><th>Error</th></tr></thead>
							<tbody>
								${recentView.length === 0 ? html`<tr><td colspan="9" class="dash-empty">No requests in this window yet.</td></tr>` : null}
								${recentView.map((r) => html`<tr>
									<td title=${new Date(r.ts).toISOString()}>${timeLabel(r.ts, false)}</td>
									<td>${r.kind}</td>
									<td>${r.provider ?? "—"}</td>
									<td>${r.model ?? "—"}</td>
									<td>${fmtTokens(r.promptTokens)}</td>
									<td>${fmtTokens(r.completionTokens)}</td>
									<td>${r.promptTokens > 0 ? `${Math.round((r.cacheReadTokens / r.promptTokens) * 100)}%` : "—"}</td>
									<td>${fmtMs(r.latencyMs)}</td>
									<td title=${r.error ?? ""}>${r.error ? (r.error.length > 40 ? `${r.error.slice(0, 40)}…` : r.error) : "—"}</td>
								</tr>`)}
							</tbody>
						</table>
					</div>
				`
				: html`
					<div class="dash-kpis">
						<${KpiCard} label="Requests" value=${fmtTokens(perfTotals.requests)} sub=${rangeLabel} />
						<${KpiCard} label="Avg latency" value=${fmtMs(perfAvgLatency)} />
						<${KpiCard} label="Worst latency" value=${fmtMs(perfTotals.max)} />
						<${KpiCard} label="5xx errors" value=${perfTotals.errors} tone=${perfTotals.errors > 0 ? "err" : ""} />
					</div>
					<div class="dash-charts">
						<div class="dash-chart-box dash-chart-box-wide"><div class="dash-chart-title">Endpoint requests & latency</div><div class="dash-chart"><canvas id="dash-chart-endpoints" /></div></div>
					</div>
					<div class="dash-section-title">Endpoints</div>
					<div class="dash-table-wrap">
						<table class="dash-table">
							<thead><tr><th>Method</th><th>Path</th><th>Requests</th><th>Avg ms</th><th>Worst ms</th><th>5xx</th></tr></thead>
							<tbody>
								${perf.overview.length === 0 ? html`<tr><td colspan="6" class="dash-empty">No API requests in this window yet.</td></tr>` : null}
								${perf.overview.map((r) => html`<tr>
									<td>${r.method}</td>
									<td>${r.path}</td>
									<td>${r.requests}</td>
									<td>${fmtMs(r.avgLatencyMs)}</td>
									<td>${fmtMs(r.maxLatencyMs)}</td>
									<td>${r.errors}</td>
								</tr>`)}
							</tbody>
						</table>
					</div>
				`}
				</div>
			</div>
		</div>
	`;
}
