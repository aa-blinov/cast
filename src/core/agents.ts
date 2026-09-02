import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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

/**
 * Extra columns to fill in when the live schema has them.
 *
 * A database migrated by the multi-tenant line of this codebase has
 * `agents.user_id INTEGER NOT NULL REFERENCES users(id)`, a column this line
 * knows nothing about — so every insert here failed outright with "NOT NULL
 * constraint failed: agents.user_id", i.e. agents could not be created at all
 * on such a store. Verified against a real one. Attribute the row to an
 * existing user (there is exactly one in a single-user install) rather than
 * inventing an id, since the column carries a foreign key.
 */
function tenantColumns(db: DatabaseSync): { columns: string[]; values: Array<string | number> } {
	const hasUserId = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some(
		(column) => column.name === "user_id",
	);
	if (!hasUserId) return { columns: [], values: [] };
	const owner = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as { id: number } | undefined;
	if (!owner) throw new Error("This database requires an owning user for agents, and no users exist yet.");
	return { columns: ["user_id"], values: [owner.id] };
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
	const tenant = tenantColumns(db);
	const columns = ["id", "name", "persona", "model", "provider", "created_at", "updated_at", ...tenant.columns];
	db.prepare(`INSERT INTO agents (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
		agent.id,
		agent.name,
		agent.persona,
		agent.model ?? null,
		agent.provider ?? null,
		agent.createdAt,
		agent.updatedAt,
		...tenant.values,
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
