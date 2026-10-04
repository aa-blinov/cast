import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AppConfig, fetchModels } from "./config.ts";
import { getDb } from "./db.ts";

const execFileAsync = promisify(execFile);

export interface DoctorInput {
	config: AppConfig;
	model: string;
	cwd: string;
	/** The connected servers, in the shape the MCP loader reports them. */
	mcp?: {
		allServerNames: string[];
		connections: { serverName: string; alive?: boolean; deadReason?: string }[];
		diagnostics: string[];
	};
}

export interface DoctorCheck {
	status: "ok" | "warn" | "fail";
	name: string;
	detail: string;
}

const MIN_NODE_MAJOR = 22;

async function tool(command: string, args: string[], cwd: string): Promise<string | undefined> {
	try {
		return (await execFileAsync(command, args, { cwd, timeout: 5_000 })).stdout.trim();
	} catch {
		return undefined;
	}
}

/**
 * `/doctor`: the things that make cast not work and are not obvious from the symptom: no route to the provider, a model
 * the provider does not have, a missing tool, an MCP server that did not come up. Read-only; every check reports instead
 * of throwing, so one broken part never hides the rest.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const major = Number(process.versions.node.split(".")[0]);
	checks.push({
		status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
		name: "Node",
		detail:
			major >= MIN_NODE_MAJOR
				? process.versions.node
				: `${process.versions.node}, cast needs ${MIN_NODE_MAJOR} or newer`,
	});

	if (!input.config.apiKey) {
		checks.push({ status: "warn", name: "Provider", detail: `${input.config.baseURL}: no API key set` });
	}
	const fetched = await fetchModels(input.config);
	const models = fetched.models ?? [];
	if (!fetched.ok) {
		checks.push({ status: "fail", name: "Provider", detail: `${input.config.baseURL}: ${fetched.error}` });
	} else if (models.some((m) => m.id === input.model)) {
		checks.push({
			status: "ok",
			name: "Provider",
			detail: `${input.config.baseURL} answers, ${input.model} is served`,
		});
	} else {
		checks.push({
			status: "fail",
			name: "Model",
			detail: `${input.model} is not among the ${models.length} models ${input.config.baseURL} lists`,
		});
	}

	const git = await tool("git", ["--version"], input.cwd);
	if (!git) checks.push({ status: "fail", name: "git", detail: "not found on PATH" });
	else {
		const inside = await tool("git", ["rev-parse", "--is-inside-work-tree"], input.cwd);
		checks.push({
			status: "ok",
			name: "git",
			detail: `${git.replace("git version ", "")}${inside === "true" ? "" : ", this folder is not a repository"}`,
		});
	}
	const rg = await tool("rg", ["--version"], input.cwd);
	checks.push(
		rg
			? { status: "ok", name: "ripgrep", detail: rg.split("\n")[0]! }
			: {
					status: "warn",
					name: "ripgrep",
					detail: "not found on PATH: the search tool falls back to a slower path",
				},
	);

	try {
		const row = getDb().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
		checks.push({ status: "ok", name: "Sessions database", detail: `${row.n} sessions` });
	} catch (error) {
		checks.push({
			status: "fail",
			name: "Sessions database",
			detail: error instanceof Error ? error.message : String(error),
		});
	}

	if (input.mcp && input.mcp.allServerNames.length > 0) {
		for (const name of input.mcp.allServerNames) {
			const conn = input.mcp.connections.find((c) => c.serverName === name);
			const prefix = `mcp server "${name}": `;
			const note = input.mcp.diagnostics.find((d) => d.startsWith(prefix))?.slice(prefix.length);
			if (conn && conn.alive !== false) checks.push({ status: "ok", name: `MCP ${name}`, detail: "connected" });
			else checks.push({ status: "fail", name: `MCP ${name}`, detail: conn?.deadReason ?? note ?? "not connected" });
		}
	}
	return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
	const lines = checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}`);
	const failed = checks.filter((c) => c.status === "fail").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	lines.push("", failed + warned === 0 ? "All good." : `${failed} failed, ${warned} warnings.`);
	return lines.join("\n");
}
