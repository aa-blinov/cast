import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";

const html = htm.bind(h);

function formatDate(value) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function shortSessionId(value) {
	return value ? value.slice(0, 8) : "";
}

export function memoryImportanceLabel(value) {
	const score = Number(value);
	if (score >= 90) return "CRITICAL";
	if (score >= 70) return "HIGH";
	if (score >= 40) return "MEDIUM";
	return "LOW";
}

export function MemoryExplorer({ activeId }) {
	const [items, setItems] = useState([]);
	const [checkpoint, setCheckpoint] = useState(null);
	const [artifacts, setArtifacts] = useState([]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState(null);
	const requestVersionRef = useRef(0);
	const activeIdRef = useRef(activeId);
	const searchTimerRef = useRef(null);
	activeIdRef.current = activeId;

	const load = useCallback(
		async (nextQuery) => {
			if (!activeId) return;
			const version = ++requestVersionRef.current;
			const searchingNow = Boolean(nextQuery);
			setLoading(!searchingNow);
			setSearching(searchingNow);
			try {
				const suffix = nextQuery ? `?q=${encodeURIComponent(nextQuery)}` : "";
				const data = await api("GET", `/api/sessions/${activeId}/memory${suffix}`);
				if (activeIdRef.current !== activeId || requestVersionRef.current !== version) return;
				setItems(data?.items ?? []);
				setCheckpoint(data?.checkpoint ?? null);
				setArtifacts(data?.artifacts ?? []);
				setError(null);
			} catch (err) {
				if (activeIdRef.current === activeId && requestVersionRef.current === version) setError(err.message);
			} finally {
				if (activeIdRef.current === activeId && requestVersionRef.current === version) {
					setLoading(false);
					setSearching(false);
				}
			}
		},
		[activeId],
	);

	useEffect(() => {
		clearTimeout(searchTimerRef.current);
		requestVersionRef.current++;
		setItems([]);
		setCheckpoint(null);
		setArtifacts([]);
		setQuery("");
		setError(null);
		if (activeId) void load("");
		return () => clearTimeout(searchTimerRef.current);
	}, [activeId, load]);

	const onSearchInput = (value) => {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		const normalized = value.trim();
		if (!normalized) {
			void load("");
			return;
		}
		searchTimerRef.current = setTimeout(() => void load(normalized), 250);
	};

	if (loading) return html`<div class="memory-explorer"><div class="diff-empty">Loading memory…</div></div>`;

	return html`
		<div class="memory-explorer">
			<div class="memory-toolbar">
				<div class="memory-search-wrap">
					<${icons.magnifyingGlass} class="memory-search-icon" />
					<input class="memory-search" value=${query} placeholder="Search project memory" aria-label="Search project memory" onInput=${(event) => onSearchInput(event.target.value)} />
					${searching && html`<span class="memory-search-status">Searching…</span>`}
				</div>
				<div class="memory-summary">${query.trim() ? `${items.length} matches` : `${items.length} notes`}</div>
			</div>
			${error && html`<div class="diff-empty diff-empty-error">${error}</div>`}
			${!error && !query.trim() && checkpoint && html`<section class="memory-checkpoint">
				<div class="memory-section-label">Current checkpoint</div>
				${checkpoint.activeIntent && html`<div class="memory-checkpoint-row"><span>Intent</span><strong>${checkpoint.activeIntent}</strong></div>`}
				${checkpoint.nextAction && html`<div class="memory-checkpoint-row"><span>Next</span><strong>${checkpoint.nextAction}</strong></div>`}
			</section>`}
			${!error && !query.trim() && artifacts.length > 0 && html`<section class="memory-artifacts">
				<div class="memory-section-label">Reusable workflows</div>
				${artifacts.map((artifact) => html`<article key=${artifact.id} class="memory-artifact">
					<div class="memory-card-topline"><span class="memory-type">${artifact.kind}</span><span class="memory-artifact-name">${artifact.name}</span></div>
					<p class="memory-content">${artifact.description}</p>
				</article>`)}
			</section>`}
			${!error && items.length === 0
				? html`<div class="diff-empty diff-empty-hint"><div><p class="diff-empty-title">${query.trim() ? "No matching memory" : "No project memory yet"}</p><p>${query.trim() ? "Try fewer or more distinctive terms." : "Durable notes created by the agent will appear here across sessions."}</p></div></div>`
				: html`<div class="memory-list">${items.map(
						(item) => html`
							<article key=${item.id} class="memory-card">
								<div class="memory-card-topline">
									<span class="memory-type">${item.type}</span>
									<span class=${`memory-badge memory-badge-${memoryImportanceLabel(item.importance).toLowerCase()}`} title=${`Importance ${item.importance} of 100`}>${memoryImportanceLabel(item.importance)}</span>
								</div>
								<p class="memory-content">${item.content}</p>
								<div class="memory-meta">
									<span>${formatDate(item.updatedAt)}</span>
									${item.sourceSessionId && html`<span title=${item.sourceSessionId}>Session ${shortSessionId(item.sourceSessionId)}</span>`}
								</div>
							</article>
						`,
					)}</div>`}
		</div>
	`;
}
