import { randomUUID } from "node:crypto";

export type AgentActorStatus = "pending" | "running" | "success" | "failure" | "cancelled";
export type AgentActorMode = "main" | "subagent";
export type AgentActorLifecycle = "ephemeral" | "persistent";

export interface AgentActorSpec {
	parentSessionId?: string;
	parentActorId?: string;
	sessionId?: string;
	agent: string;
	mode: AgentActorMode;
	background: boolean;
	lifecycle: AgentActorLifecycle;
}

export interface AgentActorSnapshot extends AgentActorSpec {
	id: string;
	status: AgentActorStatus;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
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
		super("Agent actor was cancelled before it started");
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
}

function now(): string {
	return new Date().toISOString();
}

function isTerminal(status: AgentActorStatus): boolean {
	return status === "success" || status === "failure" || status === "cancelled";
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
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		completedAt: record.completedAt,
	});
}

export class AgentActorRegistry {
	private readonly records = new Map<string, AgentActorRecord>();

	constructor(private readonly terminalLimit = 512) {}

	spawn(spec: AgentActorSpec, parentSignal?: AbortSignal): AgentActorHandle {
		const controller = new AbortController();
		let resolveWait!: (status: AgentActorStatus) => void;
		const wait = new Promise<AgentActorStatus>((resolve) => {
			resolveWait = resolve;
		});
		const record: AgentActorRecord = {
			...spec,
			id: randomUUID(),
			status: "pending",
			createdAt: now(),
			updatedAt: now(),
			controller,
			started: false,
			resolveWait,
			wait,
		};
		this.records.set(record.id, record);

		const finish = (status: "success" | "failure" | "cancelled"): void => {
			if (isTerminal(record.status)) return;
			record.status = status;
			record.updatedAt = now();
			record.completedAt = record.updatedAt;
			record.parentCleanup?.();
			record.resolveWait(status);
			this.pruneTerminalRecords();
		};

		const cancel = (): void => {
			if (isTerminal(record.status)) return;
			controller.abort();
			if (!record.started) finish("cancelled");
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
				if (record.status === "cancelled" || controller.signal.aborted) {
					finish("cancelled");
					throw new AgentActorCancelledError();
				}
				record.status = "running";
				record.updatedAt = now();
				try {
					const value = await work(controller.signal);
					finish(controller.signal.aborted ? "cancelled" : (classify?.(value) ?? "success"));
					return value;
				} catch (error) {
					finish(controller.signal.aborted ? "cancelled" : "failure");
					throw error;
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
		return [...this.records.values()].map(snapshotOf);
	}

	clear(): void {
		for (const record of this.records.values()) record.parentCleanup?.();
		this.records.clear();
	}

	private pruneTerminalRecords(): void {
		const terminal = [...this.records.values()]
			.filter((record) => isTerminal(record.status))
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		for (const record of terminal.slice(0, Math.max(0, terminal.length - this.terminalLimit))) {
			this.records.delete(record.id);
		}
	}
}

export const agentActorRegistry = new AgentActorRegistry();
