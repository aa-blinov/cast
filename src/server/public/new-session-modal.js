/**
 * "New session" modal — replaces the old sidebar-embedded persona+directory
 * picker with a single dedicated form. Holds persona, cwd, sandbox vs
 * directory, optional git-worktree isolation, and a model override.
 *
 * Lifecycle: the parent (App) renders this as a controlled component and
 * calls `onCreate({ persona, cwd, worktree, model })` when the user clicks
 * Create. The caller is responsible for the actual `startDraft` /
 * `commitSession` dance — this modal is just a form, not a session
 * lifecycle owner. The old sidebar persona-row + dir-toggle stay around
 * only as a fallback for /new slash command and the bootstrap "first
 * session" auto-pick; the user-facing new-session entry point is this
 * modal.
 */

import htm from "htm";
import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { SANDBOX_CWD, shortPath } from "./sidebar-utils.js";

const HOME_DIR_RE = /^\/(?:home|Users)\/[^/]+$/;

const html = htm.bind(h);

/** Default worktree name. Mirrors the `cast-<id>` shape that the
 * bridge uses for sandbox sessions: `tree-` + 8 random hex chars. Stays
 * under the 64-char server-side limit and avoids any path-traversal
 * sequences the slug validator would reject. */
function defaultWorktreeName() {
	// 8 chars of entropy is enough to avoid collisions across the few
	// open sessions a single user is likely to spin up concurrently.
	// crypto.getRandomValues is available in every modern browser and
	// jsdom, so this works in both production and the unit-test runtime.
	const bytes = new Uint8Array(4);
	(globalThis.crypto ?? globalThis.crypto).getRandomValues(bytes);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return `tree-${hex}`;
}

export function NewSessionModal({
	open,
	personas,
	defaultPersona,
	cwd,
	defaultCwd,
	defaultModel,
	onSetCwd,
	onOpenDirPicker,
	onCreate,
	onClose,
}) {
	const [persona, setPersona] = useState(defaultPersona ?? personas[0]?.name ?? "");
	const [provider, setProvider] = useState("");
	const [providers, setProviders] = useState(null);
	const [model, setModel] = useState("");
	const [models, setModels] = useState(null);
	const [checkingModel, setCheckingModel] = useState(false);
	const [modelCheck, setModelCheck] = useState(null);
	const [sandbox, setSandbox] = useState(false);
	const [worktreeEnabled, setWorktreeEnabled] = useState(false);
	const [worktreeName, setWorktreeName] = useState(() => defaultWorktreeName());
	const [gitInfo, setGitInfo] = useState(null); // null = loading, {isGit:false} = no, {isGit:true, hasCommits, branch}
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	const modalRef = useModalFocusTrap(!!open);

	// Reset form when the modal opens so a stale "feature-x" from a prior
	// open doesn't survive into a new session, and so defaultPersona /
	// defaultCwd are honoured fresh.
	useEffect(() => {
		if (!open) return;
		// persona's pinned model/provider is the default for this persona — see personas.ts `model`/`provider` frontmatter
		const pinnedPersona = personas.find((p) => p.name === (defaultPersona ?? personas[0]?.name ?? ""));
		const pinned = pinnedPersona?.model;
		const pinnedProvider = pinnedPersona?.provider;
		setPersona(defaultPersona ?? personas[0]?.name ?? "");
		// provider must not stay on placeholder while model already shows default — infer from active/providers or model prefix
		const activeName = (providers || []).find((p) => p.active)?.name;
		const inferredProvider = pinnedProvider || activeName || (defaultModel?.startsWith("MiniMax") ? "minimax" : "") || (pinned && pinned.startsWith("MiniMax") ? "minimax" : "");
		setProvider(inferredProvider);
		setModel(pinned ?? defaultModel ?? "");
		setModelCheck(null);
		// by default sandbox — safer isolated session; user explicitly picks Select dir if needs repo
		setSandbox(true);
		setWorktreeEnabled(false);
		// Fresh tree-XXXX each open so parallel worktrees never collide.
		setWorktreeName(defaultWorktreeName());
		setError(null);
		setBusy(false);
	}, [open, defaultPersona, personas, defaultModel]);

	useEffect(() => {
		if (!open) return;
		// providers: explicit list, no "auto" — comes from settings.providers via /provider list
		api("POST", "/api/settings/command", { command: "/provider list" })
			.then((d) => {
				const list = d?.result;
				const arr = Array.isArray(list) ? list : Array.isArray(d?.providers) ? d.providers : null;
				if (Array.isArray(arr)) {
					setProviders(arr);
					// default provider = active (standard) if nothing selected and no persona pin — use functional update to avoid stale closure
					const active = arr.find((p) => p.active)?.name;
					if (active) setProvider((prev) => prev || active);
				}
			})
			.catch(() => {});
		api("GET", "/api/models/cached")
			.then((d) => {
				if (d?.models && Array.isArray(d.models)) setModels(d.models);
				else if (Array.isArray(d)) setModels(d);
			})
			.catch(() => {
				api("GET", "/api/models")
					.then((d) => {
						if (d?.models && Array.isArray(d.models)) setModels(d.models);
					})
					.catch(() => {});
			});
	}, [open]);

	// load models for selected provider — so "any change provider→model" has fresh list and ✓ can verify pair
	useEffect(() => {
		if (!open || !provider) return;
		let cancelled = false;
		api("GET", `/api/models?provider=${encodeURIComponent(provider)}`)
			.then((d) => {
				if (cancelled) return;
				if (d?.models && Array.isArray(d.models)) setModels(d.models);
			})
			.catch(() => {});
		return () => { cancelled = true; };
	}, [open, provider]);

	// when persona changes, auto-fill its pinned provider/model (if any) — user can still override
	useEffect(() => {
		if (!open) return;
		const p = personas.find((x) => x.name === persona);
		if (p?.provider) setProvider(p.provider);
		// don't auto-clear model if persona has no pin — keep user's manual choice
		if (p?.model) setModel(p.model);
		setModelCheck(null);
	}, [persona]);

	// cwd is the controlled value from App (sidebar lives off the same
	// state); when the user clicks "Select dir" the parent opens the
	// DirectoryBrowser and writes its pick back through onSetCwd. The
	// modal needs to seed that with the parent's current cwd on open so
	// the picker starts in the right place.
	useEffect(() => {
		if (!open) return;
		if (cwd) return;
		// App-level defaultCwd may still be empty during the first ms of
		// initClientState — fetch it ourselves as a fallback so the picker
		// and the eventual createSession both start from $HOME, not from
		// the sandbox sentinel.
		if (defaultCwd) {
			onSetCwd?.(defaultCwd);
			return;
		}
		let cancelled = false;
		api("GET", "/api/config")
			.then((data) => {
				if (!cancelled && data?.cwd && !cwd) onSetCwd?.(data.cwd);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open, cwd, defaultCwd, onSetCwd]);

	// A saved model override in settings (defaultModel) sticks to the current
	// session on first submit; no UI override here yet because the web has
	// no model picker endpoint (see the model field on the Settings →
	// Provider tab instead). defaultModel is shown only as a hint so the
	// user knows what's about to be used.
	void defaultModel;

	// Probe git context whenever the cwd changes. Cheap (one rev-parse), but
	// still debounced via the dependency so it doesn't fire mid-typing on
	// every keystroke. The modal hides the worktree section when
	// `gitInfo?.isGit` is false or while loading, so the user never sees
	// a checkbox that would fail at submit.
	useEffect(() => {
		if (!open) return;
		const target = sandbox ? SANDBOX_CWD : cwd;
		if (!target) {
			setGitInfo(null);
			return;
		}
		setGitInfo(null);
		let cancelled = false;
		api("GET", `/api/git-info?cwd=${encodeURIComponent(target)}`)
			.then((data) => {
				if (!cancelled) setGitInfo(data ?? { isGit: false });
			})
			.catch(() => {
				if (!cancelled) setGitInfo({ isGit: false });
			});
		return () => {
			cancelled = true;
		};
	}, [open, sandbox, cwd]);

	// Sandbox and worktree are mutually exclusive — enabling one clears
	// the other, matching the server-side guard. The UI's job is just
	// to make the conflict obvious to the user so they don't fill the
	// form and then get a 400 at submit.
	const onSandboxChange = (next) => {
		setSandbox(next);
		if (next) setWorktreeEnabled(false);
	};
	const onWorktreeChange = (next) => {
		setWorktreeEnabled(next);
		if (next) setSandbox(false);
	};

	const worktreeOk = !worktreeEnabled || (gitInfo?.isGit && gitInfo?.hasCommits !== false);
	const canSubmit = useMemo(() => {
		if (busy) return false;
		if (!persona) return false;
		if (sandbox) return true; // cwd derived server-side from session id
		if (!cwd) return false;
		if (worktreeEnabled && !worktreeName.trim()) return false;
		if (worktreeEnabled && !worktreeOk) return false;
		return true;
	}, [busy, persona, cwd, sandbox, worktreeEnabled, worktreeName, worktreeOk]);

	const onSubmit = async () => {
		setBusy(true);
		try {
			await onCreate({
				persona,
				provider: provider || undefined,
				model: model || undefined,
				cwd: sandbox ? SANDBOX_CWD : cwd,
				worktree: worktreeEnabled && worktreeName.trim() ? worktreeName.trim() : undefined,
			});
			// success is signalled by the parent unmounting the modal — don't
			// clear `busy` here so the button stays disabled until then.
		} catch (_err) {
			setBusy(false);
		}
	};

	if (!open) return null;
	// Show "~" when cwd looks like the user's home (`/home/<user>` or
	// `/Users/<user>`), so the modal's default reads naturally as "the
	// home directory, not a project path". Anything else goes through
	// shortPath's ellipsis form. Empty cwd falls back to a literal "~"
	// too — the server resolves an empty cwd to homedir() at session-
	// create time, so the resulting session lives in the same place.
	const homeMatch = HOME_DIR_RE.test(cwd);
	const cwdLabel = sandbox ? "Sandbox" : !cwd ? "~" : homeMatch ? "~" : shortPath(cwd);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div
				class="modal modal-new-session"
				role="dialog"
				aria-modal="true"
				aria-label="New session"
				tabIndex="-1"
				ref=${modalRef}
				onClick=${(e) => e.stopPropagation()}
			>
				<div class="modal-header">
					<span>New session</span>
					<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="new-session-body">
					<div class="new-session-section-title">Persona</div>
					<div class="new-session-personas">
						${personas.map(
							(p) => html`
								<button
									key=${p.name}
									class=${`new-session-persona${persona === p.name ? " selected" : ""}`}
									onClick=${() => setPersona(p.name)}
									type="button"
								>
									<span class="new-session-persona-label">${p.label}</span>
									<span class="new-session-persona-source">${p.source}</span>
								</button>
							`,
						)}
					</div>

					<div class="new-session-section-title">Provider & Model</div>
					<div class="new-session-model">
						<select
							value=${provider}
							disabled=${busy}
							onChange=${(e) => { setProvider(e.target.value); setModelCheck(null); }}
						>
							<option value="">— Select provider —</option>
							${(providers || []).map((p) => html`<option value=${p.name}>${p.name}</option>`)}
						</select>
						<div class="new-session-model-row">
							<select
								value=${model}
								disabled=${busy}
								onChange=${(e) => { setModel(e.target.value); setModelCheck(null); }}
							>
								<option value="">— Select model —</option>
								${(models || []).filter((m) => !provider || (m.provider && m.provider === provider) || !m.provider).slice(0, 50).map((m) => html`<option value=${m.id}>${m.id}${m.provider ? ` · ${m.provider}` : ""}</option>`)}
							</select>
							<button class="modal-btn icon-btn verify-btn" title="Проверить доступность модели" disabled=${busy || checkingModel || !provider || !model} onClick=${async () => {
							setCheckingModel(true); setModelCheck(null);
							try{
								// verify the exact provider+model pair — any change keeps button enabled (save is Create session)
								const res = await api("POST", "/api/provider/verify", { provider });
								if (res?.ok) {
									const list = await api("GET", `/api/models?provider=${encodeURIComponent(provider)}`).catch(()=>null);
									const hasModel = list?.models?.some((x) => x.id === model);
									setModelCheck({ ok: !!hasModel, msg: hasModel ? `✓ ${model} отвечает via ${provider}` : `✕ ${model} не найден для ${provider}` });
								} else {
									setModelCheck({ ok: false, msg: res?.error || "Provider unreachable" });
								}
							} catch (e) { setModelCheck({ ok: false, msg: e.message }); }
							finally { setCheckingModel(false); }
						}} class="verify-btn">${checkingModel ? html`<span class="settings-inline-loader" aria-label="Checking" />` : html`<${icons.arrowPath} />`}</button>
						</div>
					</div>
					${modelCheck ? html`<div class=${modelCheck.ok ? "modal-hint" : "new-session-error"} style="margin-bottom:8px; font-size:.72rem; line-height:1.4">${modelCheck.msg}</div>` : null}

					<div class="new-session-section-title">Working directory</div>
					<div class="new-session-cwd">
						<button
							type="button"
							class=${`modal-btn new-session-cwd-toggle${!sandbox ? " active" : ""}`}
							title=${cwd ? `Selected: ${cwd}` : "Pick a directory…"}
							onClick=${() => { setSandbox(false); setWorktreeEnabled(false); onOpenDirPicker?.(); }}
						>Select dir</button>
						<button
							type="button"
							class=${`modal-btn new-session-cwd-toggle${sandbox ? " active" : ""}`}
							title=${cwd && !sandbox ? `Selected: ${cwd}` : "Create a fresh sandbox directory for a throwaway session"}
							onClick=${() => onSandboxChange(!sandbox)}
						>Sandbox</button>
					</div>
					${
						!sandbox &&
						cwd &&
						html`
						<div class="new-session-cwd-preview">
							<${icons.folder} />
							<span class="new-session-cwd-preview-label">Working directory</span>
							<code class="new-session-cwd-preview-path">${cwdLabel}</code>
						</div>
					`
					}
					${
						sandbox &&
						html`
						<div class="new-session-cwd-preview">
							<${icons.folder} />
							<span class="new-session-cwd-preview-label">Sandbox session</span>
							<code class="new-session-cwd-preview-path">~/.cast/sandbox/cast-[id]</code>
						</div>
					`
					}

					${
						!sandbox && (gitInfo === null || gitInfo?.isGit)
							? html`
						<div class="new-session-worktree">
							<label class="new-session-checkbox">
								<input
									type="checkbox"
									checked=${worktreeEnabled}
									onChange=${(e) => onWorktreeChange(e.target.checked)}
								/>
								<span>Run in an isolated git worktree</span>
							</label>
							${
								worktreeEnabled
									? html`
								<div class="new-session-form-row">
									<input
										class="new-session-input"
										type="text"
										placeholder=${worktreeName}
										value=${worktreeName}
										onInput=${(e) => setWorktreeName(e.target.value)}
									/>
								</div>
								<p class="modal-hint">
									Creates <code>${worktreeName || "[name]"}.cast/worktrees/</code> on branch
									<code>cast-${worktreeName || "[name]"}</code> off HEAD. The main checkout
									is left untouched. The worktree and branch stay on disk after the
									session ends.
								</p>
								${
									gitInfo?.isGit && gitInfo?.hasCommits === false
										? html`<p class="new-session-error">This repository has no commits yet — make an initial commit before using worktree mode.</p>`
										: null
								}
								${
									gitInfo && !gitInfo.isGit
										? html`<p class="new-session-error">Not a git repository. Worktree mode requires being inside a git checkout.</p>`
										: null
								}
							`
									: null
							}
						</div>
					`
							: null
					}

					${error ? html`<div class="new-session-error">${error}</div>` : null}
				</div>
				<div class="modal-footer">
					<button class="modal-btn" onClick=${onClose} disabled=${busy}>Cancel</button>
					<button class="modal-btn modal-btn-primary" onClick=${onSubmit} disabled=${!canSubmit}>
						${busy ? "Creating…" : "Create session"}
					</button>
				</div>
			</div>
		</div>
	`;
}
