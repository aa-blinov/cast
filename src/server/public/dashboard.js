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

// Grafana-style table footer: page-size select, "X–Y of Z", prev/next.
function DashPager({ total, pageSize, page, onPageSize, onPage }) {
	const pages = Math.max(1, Math.ceil(total / pageSize));
	const start = total === 0 ? 0 : page * pageSize + 1;
	const end = Math.min(total, (page + 1) * pageSize);
	return html`<div class="dash-pager">
		<select class="dash-pager-size" value=${pageSize} onChange=${(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page">
			<option value="10">10</option><option value="25">25</option><option value="50">50</option>
		</select>
		<span class="dash-pager-count">${start}–${end} of ${total}</span>
		<button class="dash-pager-btn" disabled=${page <= 0} onClick=${() => onPage(page - 1)} aria-label="Previous page">‹</button>
		<button class="dash-pager-btn" disabled=${page >= pages - 1} onClick=${() => onPage(page + 1)} aria-label="Next page">›</button>
	</div>`;
}

export function Dashboard({ onClose }) {
	const [tab, setTab] = useState("llm");
	const [range, setRange] = useState("24h");
	const [llm, setLlm] = useState({ overview: [], series: [] });
	const [perf, setPerf] = useState({ overview: [], series: [] });
	const [reliability, setReliability] = useState(null);
	const [system, setSystem] = useState(null);
	const [recent, setRecent] = useState({ rows: [], total: 0, page: 0, pageSize: 25 });
	const [endpointPage, setEndpointPage] = useState({ page: 0, pageSize: 10 });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [themeVersion, setThemeVersion] = useState(0);
	const chartsRef = useRef({});
	// Separate request counters for the two fetch paths so a stale response
	// from one never discards a fresh response from the other (they fire
	// concurrently on mount and on range change).
	const loadRequestIdRef = useRef(0);
	const recentRequestIdRef = useRef(0);

	// Watch the root style for theme changes (applyTheme mutates
	// document.documentElement). A single theme change sets many CSS variables,
	// which fires many mutations — debounce so charts re-color exactly once.
	useEffect(() => {
		let timer = null;
		const observer = new MutationObserver(() => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				setThemeVersion((v) => v + 1);
			}, 50);
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
		return () => {
			observer.disconnect();
			if (timer) clearTimeout(timer);
		};
	}, []);

	const destroyCharts = useCallback(() => {
		for (const key of Object.keys(chartsRef.current)) {
			chartsRef.current[key]?.destroy?.();
			delete chartsRef.current[key];
		}
	}, []);

	const load = useCallback(async () => {
		const req = ++loadRequestIdRef.current;
		const hours = range === "30d" ? 720 : range === "7d" ? 168 : 24;
		const resolution = hours === 24 ? 60 : hours === 168 ? 360 : 1440;
		setLoading(true);
		setError(null);
		try {
			const [ov, se, eo, es, rel, sys] = await Promise.all([
				api("GET", `/api/telemetry/overview?since=${hours}`),
				api("GET", `/api/telemetry/series?since=${hours}&resolution=${resolution}`),
				api("GET", `/api/telemetry/endpoints?since=${hours}`),
				api("GET", `/api/telemetry/endpoint-series?since=${hours}&resolution=${resolution}`),
				api("GET", `/api/telemetry/reliability?since=${hours}`),
				api("GET", `/api/telemetry/system?since=${hours}`),
			]);
			if (req !== loadRequestIdRef.current) return;
			setLlm({ overview: ov?.rows ?? [], series: se?.buckets ?? [] });
			setPerf({ overview: eo?.rows ?? [], series: es?.buckets ?? [] });
			setReliability(rel ?? null);
			setSystem(sys ?? null);
			setEndpointPage((p) => ({ ...p, page: 0 }));
		} catch (err) {
			if (req === loadRequestIdRef.current) setError(err.message);
		} finally {
			if (req === loadRequestIdRef.current) setLoading(false);
		}
	}, [range]);

	// Server-side pagination for the recent-requests table (can grow large over
	// 30d). Fetches only the current page; total drives the page count.
	const loadRecent = useCallback(
		async (page, pageSize) => {
			const hours = range === "30d" ? 720 : range === "7d" ? 168 : 24;
			const req = ++recentRequestIdRef.current;
			try {
				const res = await api("GET", `/api/telemetry/recent?since=${hours}&limit=${pageSize}&offset=${page * pageSize}`);
				if (req === recentRequestIdRef.current) {
					setRecent({ rows: res?.rows ?? [], total: res?.total ?? 0, page, pageSize });
				}
			} catch (err) {
				if (req === recentRequestIdRef.current) setError(err.message);
			}
		},
		[range],
	);

	useEffect(() => {
		load();
		loadRecent(0, 25);
	}, [load, loadRecent]);

	// Create/refresh charts once Chart.js is ready and the active tab's data
	// is present. Re-reads theme colors every time so a theme change re-colors.
	useEffect(() => {
		if (loading) return;
		if (tab === "llm" || tab === "perf") {
			const data = tab === "llm" ? llm : perf;
			if (data.series.length === 0) return;
		}
		if (tab === "reliability" && (!reliability || (reliability.errorTypes ?? []).length === 0)) return;
		if (tab === "system" && (!system || (system.tools ?? []).length === 0)) return;
		let cancelled = false;
		loadChart()
			.then((Chart) => {
				if (cancelled) return;
				destroyCharts();
				const colors = themeColors();
				if (tab === "reliability") {
					chartsRef.current["errors"] = new Chart(document.getElementById("dash-chart-errors"), {
						type: "bar",
						data: {
							labels: reliability.errorTypes.map((t) => t.errorType),
							datasets: [
								{ label: "errors & retries", data: reliability.errorTypes.map((t) => t.count), backgroundColor: colors.rose },
							],
						},
						options: makeBaseOptions(colors),
					});
				} else if (tab === "system") {
					chartsRef.current["tools"] = new Chart(document.getElementById("dash-chart-tools"), {
						type: "bar",
						data: {
							labels: system.tools.map((t) => t.toolName),
							datasets: [
								{ label: "calls", data: system.tools.map((t) => t.count), backgroundColor: colors.cyan },
								{ label: "errors", data: system.tools.map((t) => t.errors), backgroundColor: colors.rose },
							],
						},
						options: makeBaseOptions(colors),
					});
				} else if (tab === "llm") {
					const data = llm;
					const coarse = range !== "24h";
					const labels = data.series.map((b) => timeLabel(b.ts, coarse));
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
					const coarse = range !== "24h";
					const labels = perf.series.map((b) => timeLabel(b.ts, coarse));
					chartsRef.current["endpoints"] = new Chart(document.getElementById("dash-chart-endpoints"), {
						type: "line",
						data: {
							labels,
							datasets: [
								{ label: "requests", data: perf.series.map((b) => b.requests), borderColor: colors.cyan, backgroundColor: colors.cyan, yAxisID: "y", pointRadius: 0, borderWidth: 2 },
								{ label: "avg latency ms", data: perf.series.map((b) => b.avgLatencyMs ?? null), borderColor: colors.amber, backgroundColor: colors.amber, yAxisID: "y1", pointRadius: 0, borderWidth: 1, borderDash: [4, 4] },
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
	}, [loading, tab, llm, perf, reliability, system, range, themeVersion, destroyCharts]);

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

	const rangeLabel = range === "30d" ? "30 days" : range === "7d" ? "7 days" : "24 hours";
	const retryRate =
		reliability && reliability.requests > 0 ? ((reliability.retries / reliability.requests) * 100).toFixed(1) : null;
	// Client-side pagination over the already-fetched endpoint overview.
	const epPage = endpointPage;
	const epRows = perf.overview.slice(epPage.page * epPage.pageSize, (epPage.page + 1) * epPage.pageSize);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal dash-modal" role="dialog" aria-modal="true" aria-label="Dashboard" tabIndex="-1" onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span class="dash-title">Dashboard</span>
					<div class="dash-tabs">
						<button class="modal-btn${tab === "llm" ? " modal-btn-primary" : ""}" onClick=${() => setTab("llm")}>LLM</button>
						<button class="modal-btn${tab === "perf" ? " modal-btn-primary" : ""}" onClick=${() => setTab("perf")}>Performance</button>
						<button class="modal-btn${tab === "reliability" ? " modal-btn-primary" : ""}" onClick=${() => setTab("reliability")}>Reliability</button>
						<button class="modal-btn${tab === "system" ? " modal-btn-primary" : ""}" onClick=${() => setTab("system")}>System</button>
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
					${loading
						? html`<div class="dash-loading"><span class="dash-spinner" /> Loading…</div>`
						: html`${tab === "llm"
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
								${recent.rows.length === 0 ? html`<tr><td colspan="9" class="dash-empty">No requests in this window yet.</td></tr>` : null}
								${recent.rows.map((r) => html`<tr>
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
						<${DashPager}
							total=${recent.total}
							pageSize=${recent.pageSize}
							page=${recent.page}
							onPageSize=${(s) => loadRecent(0, s)}
							onPage=${(p) => loadRecent(p, recent.pageSize)}
						/>
					</div>
				`
				: tab === "perf"
					? html`
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
								${epRows.length === 0 ? html`<tr><td colspan="6" class="dash-empty">No API requests in this window yet.</td></tr>` : null}
								${epRows.map((r) => html`<tr>
									<td>${r.method}</td>
									<td>${r.path}</td>
									<td>${r.requests}</td>
									<td>${fmtMs(r.avgLatencyMs)}</td>
									<td>${fmtMs(r.maxLatencyMs)}</td>
									<td>${r.errors}</td>
								</tr>`)}
							</tbody>
						</table>
						<${DashPager}
							total=${perf.overview.length}
							pageSize=${epPage.pageSize}
							page=${epPage.page}
							onPageSize=${(s) => setEndpointPage({ page: 0, pageSize: s })}
							onPage=${(p) => setEndpointPage((prev) => ({ ...prev, page: p }))}
						/>
					</div>
				`
					: tab === "reliability"
						? html`
					<div class="dash-kpis">
						<${KpiCard} label="Requests" value=${fmtTokens(reliability?.requests ?? 0)} sub=${rangeLabel} />
						<${KpiCard} label="Retries" value=${fmtTokens(reliability?.retries ?? 0)} />
						<${KpiCard} label="Retry rate" value=${retryRate ? `${retryRate}%` : "—"} sub=${retryRate ? `of ${fmtTokens(reliability.requests)} requests` : ""} />
						<${KpiCard} label="Moderation blocks" value=${fmtTokens(reliability?.refusals ?? 0)} tone=${(reliability?.refusals ?? 0) > 0 ? "err" : ""} />
					</div>
					<div class="dash-charts">
						<div class="dash-chart-box dash-chart-box-wide"><div class="dash-chart-title">Errors & retries by type</div><div class="dash-chart"><canvas id="dash-chart-errors" /></div></div>
					</div>
					<div class="dash-section-title">Error & retry breakdown</div>
					<div class="dash-table-wrap">
						<table class="dash-table">
							<thead><tr><th>Type</th><th>Count</th></tr></thead>
							<tbody>
								${!reliability || reliability.errorTypes.length === 0 ? html`<tr><td colspan="2" class="dash-empty">No errors or retries in this window.</td></tr>` : null}
								${(reliability?.errorTypes ?? []).map((t) => html`<tr><td>${t.errorType}</td><td>${t.count}</td></tr>`)}
							</tbody>
						</table>
					</div>
				`
						: html`
					<div class="dash-kpis">
						<${KpiCard} label="Compactions" value=${fmtTokens(system?.compactions?.count ?? 0)} sub=${system?.compactions?.count ? `compacted ${fmtTokens(system.compactions.messagesCompacted)} msgs` : ""} />
						<${KpiCard} label="Context saved" value=${fmtTokens(system?.compactions?.tokensBefore ?? 0)} />
						<${KpiCard} label="Avg context use" value=${system?.context?.avgUtilizationPct != null ? `${system.context.avgUtilizationPct}%` : "—"} sub=${system?.context?.avgPromptTokens != null ? `${fmtTokens(system.context.avgPromptTokens)} prompt tokens` : ""} />
						<${KpiCard} label="Sessions" value=${fmtTokens(system?.sessions?.sessions ?? 0)} sub=${system?.sessions?.avgMessagesPerSession != null ? `~${Math.round(system.sessions.avgMessagesPerSession)} msgs/session` : ""} />
					</div>
					<div class="dash-charts">
						<div class="dash-chart-box dash-chart-box-wide"><div class="dash-chart-title">Tool calls</div><div class="dash-chart"><canvas id="dash-chart-tools" /></div></div>
					</div>
					<div class="dash-section-title">Tool usage</div>
					<div class="dash-table-wrap">
						<table class="dash-table">
							<thead><tr><th>Tool</th><th>Calls</th><th>Errors</th></tr></thead>
							<tbody>
								${!system || system.tools.length === 0 ? html`<tr><td colspan="3" class="dash-empty">No tool calls in this window.</td></tr>` : null}
								${(system?.tools ?? []).map((t) => html`<tr><td>${t.toolName}</td><td>${t.count}</td><td>${t.errors}</td></tr>`)}
							</tbody>
						</table>
					</div>
				`}
			`}
			</div>
		</div>
	</div>
	`;
}
