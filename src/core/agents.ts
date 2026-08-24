import { randomBytes } from "node:crypto";
import { getDb } from "./db.ts";

export interface Agent {
	id: string;
	name: string;
	persona: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
}

const AGENT_NAME_RE = /^[a-z0-9-]+$/;

function genId(): string {
	return `ag_${randomBytes(6).toString("hex")}`;
}

export function listAgents(): Agent[] {
	const db = getDb();
	const rows = db
		.prepare(
			"SELECT id, name, persona, model, provider, created_at as createdAt, updated_at as updatedAt FROM agents ORDER BY updated_at DESC",
		)
		.all() as unknown as Agent[];
	return rows;
}

export function getAgent(id: string): Agent | null {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT id, name, persona, model, provider, created_at as createdAt, updated_at as updatedAt FROM agents WHERE id = ?",
		)
		.get(id) as unknown as Agent | undefined;
	return row ?? null;
}

export function createAgent(opts: { name: string; persona?: string; model?: string; provider?: string }): Agent {
	if (!AGENT_NAME_RE.test(opts.name)) throw new Error("Agent name must be lowercase a-z, 0-9, hyphens only");
	if (opts.name.length > 64) throw new Error("Agent name too long");
	const db = getDb();
	const existing = db.prepare("SELECT id FROM agents WHERE name = ?").get(opts.name) as { id: string } | undefined;
	if (existing) throw new Error(`Agent name "${opts.name}" already exists`);
	const now = new Date().toISOString();
	const agent: Agent = {
		id: genId(),
		name: opts.name,
		persona: opts.persona ?? "senior",
		model: opts.model,
		provider: opts.provider,
		createdAt: now,
		updatedAt: now,
	};
	db.prepare(
		"INSERT INTO agents (id, name, persona, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		agent.id,
		agent.name,
		agent.persona,
		agent.model ?? null,
		agent.provider ?? null,
		agent.createdAt,
		agent.updatedAt,
	);
	return agent;
}

export function deleteAgent(id: string): boolean {
	const db = getDb();
	const res = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
	return res.changes > 0;
}

export function updateAgent(id: string, patch: Partial<Pick<Agent, "persona" | "model" | "provider">>): Agent | null {
	const existing = getAgent(id);
	if (!existing) return null;
	const db = getDb();
	const now = new Date().toISOString();
	const persona = patch.persona ?? existing.persona;
	const model = patch.model !== undefined ? patch.model : existing.model;
	const provider = patch.provider !== undefined ? patch.provider : existing.provider;
	db.prepare("UPDATE agents SET persona = ?, model = ?, provider = ?, updated_at = ? WHERE id = ?").run(
		persona,
		model ?? null,
		provider ?? null,
		now,
		id,
	);
	return getAgent(id);
}
