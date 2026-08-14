import { randomUUID } from "node:crypto";
import { publishAgentActorNotification } from "./actor-events.ts";
import type { AppConfig } from "./config.ts";
import { getDb } from "./db.ts";
import type { Message } from "./llm.ts";
import { appendSessionEvent } from "./session.ts";

export type AgentActorStatus = "pending" | "running" | "success" | "failure" | "cancelled" | "stalled";
export type AgentActorMode = "main" | "subagent";
export type AgentActorLifecycle = "ephemeral" | "persistent";

export type AgentActorRecoverySpec = CheckpointWriterRecoverySpec | MemoryMaintenanceRecoverySpec;

export interface CheckpointWriterRecoverySpec {
	kind: "checkpoint-writer";
	cwd: string;
	sessionId: string;
	model: string;
	providerBaseURL: string;
	checkpointBoundary: number;
	config: Omit<AppConfig, "apiKey">;
}

export interface MemoryMaintenanceRecoverySpec {
	kind: "memory-maintenance";
	maintenanceKind: "dream" | "distill";
	cwd: string;
	sessionId: string;
	model: string;
	providerBaseURL: string;
	config: Omit<AppConfig, "apiKey">;
	messages: Message[];
}

/** Immutable context captured at the actor boundary, including the exact durable fork split. */
export interface AgentForkContext {
	inheritedMessages: Message[];
	prefix: Message[];
	tail: Message[];
	boundaryIndex: number;
	cachePrefixBoundary?: number;
	/** Compatibility alias for callers that used the original fork seam. */
	messages: Message[];
	systemPrompt?: string;
	toolNames?: string[];
	model?: string;
}

export interface AgentActorSpec {
	parentSessionId?: string;
	parentActorId?: string;
	sessionId?: string;
	agent: string;
	mode: AgentActorMode;
	background: boolean;
	lifecycle: AgentActorLifecycle;
	forkContext?: AgentForkContext;
	recovery?: AgentActorRecoverySpec;
}

export interface AgentActorSnapshot extends AgentActorSpec {
	id: string;
	status: AgentActorStatus;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface AgentActorOwnership {
	token: string;
	pid: number;
	leaseUntil: string;
}

export interface AgentActorPersistedState {
	snapshot: AgentActorSnapshot;
	ownership: AgentActorOwnership;
}

export type AgentActorTerminalStatus = Extract<AgentActorStatus, "success" | "failure" | "cancelled" | "stalled">;

export interface AgentActorNotification {
	type: "agent_actor_terminal";
	actorId: string;
	parentSessionId?: string;
	parentActorId?: string;
	sessionId?: string;
	agent: string;
	status: AgentActorTerminalStatus;
	ts: string;
}

export type AgentActorNotificationListener = (notification: AgentActorNotification) => void;
export type AgentActorRecoveryHandler = (snapshot: AgentActorSnapshot) => Promise<void>;

export interface AgentActorStore {
	load(): AgentActorPersistedState[];
	save(snapshot: AgentActorSnapshot, ownership: AgentActorOwnership): boolean;
	claimRecovery(actorId: string, previousToken: string | undefined, ownership: AgentActorOwnership): boolean;
	prune(limit: number): void;
}

export interface AgentActorRegistryOptions {
	terminalLimit?: number;
	stallAfterMs?: number;
	watchdogIntervalMs?: number;
	heartbeatIntervalMs?: number;
	leaseMs?: number;
	store?: AgentActorStore;
	onNotification?: AgentActorNotificationListener;
	recoveryHandlers?: Partial<Record<AgentActorRecoverySpec["kind"], AgentActorRecoveryHandler>>;
}

export interface AgentActorHandle {
	readonly id: string;
	readonly signal: AbortSignal;
	snapshot(): AgentActorSnapshot;
	cancel(): void;
	wait(): Promise<AgentActorStatus>;
	run<T>(work: (signal: AbortSignal) => Promise<T>, classify?: (value: T) => "success" | "failure"): Promise<T>;
}

export class AgentActorCancelledError extends Error {
	constructor() {
		super("Agent actor was cancelled");
		this.name = "AgentActorCancelledError";
	}
}

interface AgentActorRecord extends AgentActorSpec {
	id: string;
	status: AgentActorStatus;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	controller: AbortController;
	started: boolean;
	resolveWait: (status: AgentActorStatus) => void;
	wait: Promise<AgentActorStatus>;
	parentCleanup?: () => void;
	ownership: AgentActorOwnership;
}

interface SqliteActorRow {
	id: string;
	parent_session_id: string | null;
	parent_actor_id: string | null;
	session_id: string | null;
	agent: string;
	mode: string;
	background: number;
	lifecycle: string;
	status: string;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	fork_json: string | null;
	recovery_json: string | null;
	owner_token: string | null;
	owner_pid: number | null;
	lease_until: string | null;
}

function now(): string {
	return new Date().toISOString();
}

function isTerminal(status: AgentActorStatus): status is AgentActorTerminalStatus {
	return status === "success" || status === "failure" || status === "cancelled" || status === "stalled";
}

function isStatus(value: string): value is AgentActorStatus {
	return ["pending", "running", "success", "failure", "cancelled", "stalled"].includes(value);
}

function isMode(value: string): value is AgentActorMode {
	return value === "main" || value === "subagent";
}

function isLifecycle(value: string): value is AgentActorLifecycle {
	return value === "ephemeral" || value === "persistent";
}

function cloneForkContext(context: AgentForkContext | undefined): AgentForkContext | undefined {
	return context ? structuredClone(context) : undefined;
}

function snapshotOf(record: AgentActorRecord): AgentActorSnapshot {
	return Object.freeze({
		id: record.id,
		parentSessionId: record.parentSessionId,
		parentActorId: record.parentActorId,
		sessionId: record.sessionId,
		agent: record.agent,
		mode: record.mode,
		background: record.background,
		lifecycle: record.lifecycle,
		forkContext: cloneForkContext(record.forkContext),
		recovery: record.recovery ? structuredClone(record.recovery) : undefined,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		completedAt: record.completedAt,
	});
}

function snapshotFromRow(row: SqliteActorRow): AgentActorSnapshot | undefined {
	if (!isMode(row.mode) || !isLifecycle(row.lifecycle) || !isStatus(row.status)) return undefined;
	let forkContext: AgentForkContext | undefined;
	let recovery: AgentActorRecoverySpec | undefined;
	if (row.fork_json) {
		try {
			const parsed = JSON.parse(row.fork_json) as Partial<AgentForkContext>;
			if (Array.isArray(parsed.inheritedMessages) && Array.isArray(parsed.prefix) && Array.isArray(parsed.tail)) {
				forkContext = parsed as AgentForkContext;
			}
		} catch {
			// A corrupt optional fork snapshot must not hide the actor lifecycle row.
		}
	}
	if (row.recovery_json) {
		try {
			const parsed = JSON.parse(row.recovery_json) as Partial<AgentActorRecoverySpec>;
			if (
				parsed.kind === "checkpoint-writer" &&
				typeof parsed.cwd === "string" &&
				typeof parsed.sessionId === "string" &&
				typeof parsed.model === "string" &&
				typeof parsed.providerBaseURL === "string" &&
				typeof parsed.checkpointBoundary === "number" &&
				parsed.config !== undefined
			) {
				recovery = parsed as AgentActorRecoverySpec;
			} else if (
				parsed.kind === "memory-maintenance" &&
				(parsed.maintenanceKind === "dream" || parsed.maintenanceKind === "distill") &&
				typeof parsed.cwd === "string" &&
				typeof parsed.sessionId === "string" &&
				typeof parsed.model === "string" &&
				typeof parsed.providerBaseURL === "string" &&
				parsed.config !== undefined &&
				Array.isArray(parsed.messages)
			) {
				recovery = parsed as AgentActorRecoverySpec;
			}
		} catch {
			// A corrupt optional recovery descriptor must not hide the actor row.
		}
	}
	return {
		id: row.id,
		parentSessionId: row.parent_session_id ?? undefined,
		parentActorId: row.parent_actor_id ?? undefined,
		sessionId: row.session_id ?? undefined,
		agent: row.agent,
		mode: row.mode,
		background: Boolean(row.background),
		lifecycle: row.lifecycle,
		forkContext,
		recovery,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at ?? undefined,
	};
}

function ownershipFromRow(row: SqliteActorRow): AgentActorOwnership {
	return {
		token: row.owner_token ?? "",
		pid: row.owner_pid ?? 0,
		leaseUntil: row.lease_until ?? "",
	};
}

/** Durable actor metadata with a lease so two daemon processes cannot mutate one actor row. */
export class SqliteAgentActorStore implements AgentActorStore {
	load(): AgentActorPersistedState[] {
		const rows = getDb()
			.prepare("SELECT * FROM agent_actors ORDER BY updated_at DESC")
			.all() as unknown as SqliteActorRow[];
		return rows
			.map((row) => {
				const snapshot = snapshotFromRow(row);
				return snapshot ? { snapshot, ownership: ownershipFromRow(row) } : undefined;
			})
			.filter((state): state is AgentActorPersistedState => state !== undefined);
	}

	save(snapshot: AgentActorSnapshot, ownership: AgentActorOwnership): boolean {
		const result = getDb()
			.prepare(
				`INSERT INTO agent_actors
          (id, parent_session_id, parent_actor_id, session_id, agent, mode, background, lifecycle, status, created_at, updated_at, completed_at, fork_json, recovery_json, owner_token, owner_pid, lease_until, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
          parent_session_id = excluded.parent_session_id,
          parent_actor_id = excluded.parent_actor_id,
          session_id = excluded.session_id,
          agent = excluded.agent,
          mode = excluded.mode,
          background = excluded.background,
          lifecycle = excluded.lifecycle,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          fork_json = excluded.fork_json,
          recovery_json = excluded.recovery_json,
          owner_token = excluded.owner_token,
          owner_pid = excluded.owner_pid,
          lease_until = excluded.lease_until,
          revision = agent_actors.revision + 1
         WHERE agent_actors.owner_token IS excluded.owner_token OR agent_actors.owner_token = excluded.owner_token`,
			)
			.run(
				snapshot.id,
				snapshot.parentSessionId ?? null,
				snapshot.parentActorId ?? null,
				snapshot.sessionId ?? null,
				snapshot.agent,
				snapshot.mode,
				snapshot.background ? 1 : 0,
				snapshot.lifecycle,
				snapshot.status,
				snapshot.createdAt,
				snapshot.updatedAt,
				snapshot.completedAt ?? null,
				// Ephemeral task actors keep their fork in memory for the active run;
				// duplicating a whole transcript into SQLite on every heartbeat would
				// make actor telemetry compete with the session history itself.
				snapshot.lifecycle === "persistent" && snapshot.forkContext ? JSON.stringify(snapshot.forkContext) : null,
				snapshot.recovery ? JSON.stringify(snapshot.recovery) : null,
				ownership.token,
				ownership.pid,
				ownership.leaseUntil,
			);
		return result.changes > 0;
	}

	claimRecovery(actorId: string, previousToken: string | undefined, ownership: AgentActorOwnership): boolean {
		const result = getDb()
			.prepare(
				`UPDATE agent_actors
         SET owner_token = ?, owner_pid = ?, lease_until = ?, revision = revision + 1
         WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)
           AND (owner_token IS ? OR owner_token = ?)`,
			)
			.run(
				ownership.token,
				ownership.pid,
				ownership.leaseUntil,
				actorId,
				now(),
				previousToken ?? null,
				previousToken ?? "",
			);
		return result.changes > 0;
	}

	prune(limit: number): void {
		getDb()
			.prepare(
				`DELETE FROM agent_actors
         WHERE id IN (
           SELECT id FROM agent_actors
           WHERE status IN ('success', 'failure', 'cancelled', 'stalled')
           ORDER BY updated_at DESC
           LIMIT -1 OFFSET ?
         )`,
			)
			.run(limit);
	}
}

export class AgentActorRegistry {
	private readonly records = new Map<string, AgentActorRecord>();
	private readonly terminalLimit: number;
	private readonly stallAfterMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly watchdogIntervalMs: number;
	private readonly leaseMs: number;
	private readonly store?: AgentActorStore;
	private readonly onNotification?: AgentActorNotificationListener;
	private readonly recoveryHandlers = new Map<string, AgentActorRecoveryHandler>();
	private watchdog?: NodeJS.Timeout;
	private restored = false;

	constructor(options: AgentActorRegistryOptions | number = {}) {
		const normalized = typeof options === "number" ? { terminalLimit: options } : options;
		this.terminalLimit = normalized.terminalLimit ?? 512;
		this.stallAfterMs = normalized.stallAfterMs ?? 6 * 60 * 1000;
		this.heartbeatIntervalMs = normalized.heartbeatIntervalMs ?? 15_000;
		this.watchdogIntervalMs = normalized.watchdogIntervalMs ?? 45_000;
		this.leaseMs = normalized.leaseMs ?? Math.max(45_000, this.heartbeatIntervalMs * 3);
		this.store = normalized.store;
		this.onNotification = normalized.onNotification;
		for (const [kind, handler] of Object.entries(normalized.recoveryHandlers ?? {})) {
			if (handler) this.recoveryHandlers.set(kind, handler);
		}
	}

	registerRecoveryHandler(kind: AgentActorRecoverySpec["kind"], handler: AgentActorRecoveryHandler): void {
		this.recoveryHandlers.set(kind, handler);
	}

	spawn(spec: AgentActorSpec, parentSignal?: AbortSignal): AgentActorHandle {
		this.ensureRestored();
		const controller = new AbortController();
		let resolveWait!: (status: AgentActorStatus) => void;
		const wait = new Promise<AgentActorStatus>((resolve) => {
			resolveWait = resolve;
		});
		const record: AgentActorRecord = {
			...spec,
			forkContext: cloneForkContext(spec.forkContext),
			id: randomUUID(),
			status: "pending",
			createdAt: now(),
			updatedAt: now(),
			controller,
			started: false,
			resolveWait,
			wait,
			ownership: this.newOwnership(),
		};
		this.records.set(record.id, record);
		this.persist(record);

		const finish = (status: AgentActorTerminalStatus): void => {
			if (isTerminal(record.status)) return;
			record.status = status;
			record.updatedAt = now();
			record.completedAt = record.updatedAt;
			record.parentCleanup?.();
			this.persist(record);
			record.resolveWait(status);
			this.notify(record, status);
			this.pruneTerminalRecords();
		};

		const cancel = (): void => {
			if (isTerminal(record.status)) return;
			controller.abort();
			finish("cancelled");
		};

		const handle: AgentActorHandle = {
			id: record.id,
			signal: controller.signal,
			snapshot: () => snapshotOf(record),
			cancel,
			wait: () => record.wait,
			run: async <T>(work: (signal: AbortSignal) => Promise<T>, classify?: (value: T) => "success" | "failure") => {
				if (record.started) throw new Error(`Agent actor ${record.id} already started`);
				record.started = true;
				if (record.status === "cancelled" || record.status === "stalled" || controller.signal.aborted) {
					if (!isTerminal(record.status)) finish("cancelled");
					throw new AgentActorCancelledError();
				}
				record.status = "running";
				record.updatedAt = now();
				this.persist(record);
				const heartbeat = this.startHeartbeat(record);
				try {
					const value = await work(controller.signal);
					if (controller.signal.aborted || isTerminal(record.status)) {
						throw new AgentActorCancelledError();
					}
					finish(classify?.(value) ?? "success");
					return value;
				} catch (error) {
					if (!isTerminal(record.status)) finish(controller.signal.aborted ? "cancelled" : "failure");
					throw error;
				} finally {
					if (heartbeat) clearInterval(heartbeat);
				}
			},
		};

		if (parentSignal) {
			const onParentAbort = (): void => cancel();
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
			record.parentCleanup = () => parentSignal.removeEventListener("abort", onParentAbort);
			if (parentSignal.aborted) cancel();
		}
		return handle;
	}

	list(): AgentActorSnapshot[] {
		this.ensureRestored();
		return [...this.records.values()].map(snapshotOf);
	}

	cancel(id: string): boolean {
		this.ensureRestored();
		const record = this.records.get(id);
		if (!record || isTerminal(record.status)) return false;
		record.controller.abort();
		record.status = "cancelled";
		record.updatedAt = now();
		record.completedAt = record.updatedAt;
		record.parentCleanup?.();
		this.persist(record);
		record.resolveWait("cancelled");
		this.notify(record, "cancelled");
		this.pruneTerminalRecords();
		return true;
	}

	scanStalled(at = Date.now()): AgentActorSnapshot[] {
		this.ensureRestored();
		this.restorePersistentActors();
		const stalled: AgentActorSnapshot[] = [];
		for (const record of this.records.values()) {
			if (record.status !== "running") continue;
			if (at - Date.parse(record.updatedAt) <= this.stallAfterMs) continue;
			record.controller.abort();
			const before = record.status;
			if (before === "running") {
				record.status = "stalled";
				record.updatedAt = now();
				record.completedAt = record.updatedAt;
				record.parentCleanup?.();
				this.persist(record);
				record.resolveWait("stalled");
				this.notify(record, "stalled");
				stalled.push(snapshotOf(record));
			}
		}
		return stalled;
	}

	clear(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		for (const record of this.records.values()) record.parentCleanup?.();
		this.records.clear();
	}

	private restorePersistentActors(): void {
		for (const state of this.store?.load() ?? []) {
			const { snapshot, ownership } = state;
			if (snapshot.lifecycle !== "persistent") continue;
			if (this.records.has(snapshot.id)) continue;
			const leaseActive = ownership.leaseUntil.length > 0 && Date.parse(ownership.leaseUntil) > Date.now();
			if ((snapshot.status === "pending" || snapshot.status === "running") && leaseActive) continue;
			const status = snapshot.status === "pending" || snapshot.status === "running" ? "stalled" : snapshot.status;
			const recoveredOwnership = this.newOwnership();
			if (
				(snapshot.status === "pending" || snapshot.status === "running") &&
				!this.store?.claimRecovery(snapshot.id, ownership.token || undefined, recoveredOwnership)
			) {
				continue;
			}
			const restored: AgentActorRecord = {
				...snapshot,
				status,
				forkContext: cloneForkContext(snapshot.forkContext),
				controller: new AbortController(),
				started: true,
				resolveWait: () => {},
				wait: Promise.resolve(status),
				ownership: snapshot.status === "pending" || snapshot.status === "running" ? recoveredOwnership : ownership,
			};
			this.records.set(restored.id, restored);
			if (status === "stalled" && snapshot.status !== "stalled") {
				this.persist(restored);
				this.notify(restored, "stalled");
				const handler = restored.recovery ? this.recoveryHandlers.get(restored.recovery.kind) : undefined;
				if (handler) {
					void handler(snapshot).catch(() => {
						// Recovery is isolated from the restored lifecycle row; a failed
						// restart remains visible as stalled and can be retried explicitly.
					});
				}
			}
		}
		this.pruneTerminalRecords();
	}

	private ensureRestored(): void {
		if (this.restored) return;
		this.restored = true;
		this.restorePersistentActors();
		if (this.watchdogIntervalMs > 0) {
			this.watchdog = setInterval(() => this.scanStalled(), this.watchdogIntervalMs);
			this.watchdog.unref();
		}
	}

	private startHeartbeat(record: AgentActorRecord): NodeJS.Timeout | undefined {
		if (this.heartbeatIntervalMs <= 0) return undefined;
		const heartbeat = setInterval(() => {
			if (record.status !== "running") return;
			record.updatedAt = now();
			this.persist(record);
		}, this.heartbeatIntervalMs);
		heartbeat.unref();
		return heartbeat;
	}

	private persist(record: AgentActorRecord): void {
		try {
			this.store?.save(snapshotOf(record), record.ownership);
		} catch {
			// Actor durability must not turn a successful model/tool run into a failure.
		}
	}

	private notify(record: AgentActorRecord, status: AgentActorTerminalStatus): void {
		const notification: AgentActorNotification = {
			type: "agent_actor_terminal",
			actorId: record.id,
			parentSessionId: record.parentSessionId,
			parentActorId: record.parentActorId,
			sessionId: record.sessionId,
			agent: record.agent,
			status,
			ts: record.completedAt ?? now(),
		};
		try {
			this.onNotification?.(notification);
			publishAgentActorNotification(notification);
		} catch {
			// Parent notification is best effort and cannot change actor outcome.
		}
	}

	private pruneTerminalRecords(): void {
		const terminal = [...this.records.values()]
			.filter((record) => isTerminal(record.status))
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		for (const record of terminal.slice(0, Math.max(0, terminal.length - this.terminalLimit))) {
			this.records.delete(record.id);
		}
		try {
			this.store?.prune(this.terminalLimit);
		} catch {
			// Cleanup is best effort and must not affect an active actor.
		}
	}

	private newOwnership(): AgentActorOwnership {
		return {
			token: randomUUID(),
			pid: process.pid,
			leaseUntil: new Date(Date.now() + this.leaseMs).toISOString(),
		};
	}
}

export const agentActorRegistry = new AgentActorRegistry({
	store: new SqliteAgentActorStore(),
	onNotification: (notification) => {
		if (!notification.parentSessionId) return;
		try {
			appendSessionEvent(notification.parentSessionId, notification.type, notification);
		} catch {
			// A stale/deleted parent session must not break actor teardown.
		}
	},
});
