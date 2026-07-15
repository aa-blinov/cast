import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SshHostConfig {
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	password?: string;
	dangerousCommands?: "default" | "bypass";
}

export interface SshHost extends SshHostConfig {
	name: string;
}

interface SshConfigFile {
	hosts?: Record<string, SshHostConfig>;
}

export const globalSshPath = join(homedir(), ".cast", "ssh.json");
export function projectSshPath(cwd: string): string {
	return join(cwd, ".cast", "ssh.json");
}

/** Reads a `{ "hosts": { "name": { "host": "..." } } }` file. Missing or malformed = empty. */
export function loadSshConfig(path: string): Record<string, SshHostConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as SshConfigFile;
		return parsed.hosts ?? {};
	} catch {
		return {};
	}
}

/** Expand `~` in a key path. */
function expandKeyPath(keyPath: string): string {
	if (keyPath.startsWith("~/") || keyPath === "~") {
		return keyPath.replace("~", homedir());
	}
	return keyPath;
}

/** Merge global + project hosts. Project overrides global on same name. Global always loads; project only when trusted. */
export function resolveSshHosts(cwd: string, trusted: boolean): SshHost[] {
	const globalHosts = loadSshConfig(globalSshPath);
	const projectPath = projectSshPath(cwd);
	const projectHosts = trusted && existsSync(projectPath) ? loadSshConfig(projectPath) : {};

	const merged = new Map<string, SshHost>();
	for (const [name, cfg] of Object.entries(globalHosts)) {
		merged.set(name, { ...cfg, name, keyPath: cfg.keyPath ? expandKeyPath(cfg.keyPath) : undefined });
	}
	for (const [name, cfg] of Object.entries(projectHosts)) {
		merged.set(name, { ...cfg, name, keyPath: cfg.keyPath ? expandKeyPath(cfg.keyPath) : undefined });
	}
	return Array.from(merged.values());
}

// ============================================================================
// ControlMaster — SSH connection reuse via Unix sockets
// ============================================================================

// Use /tmp directly — tmpdir() on macOS can produce paths that exceed the
// 104-byte Unix socket path limit when SSH expands %C.
const CONTROL_DIR = join("/tmp", "cast-ssh-ctl");
const CONTROL_PATH = join(CONTROL_DIR, "%C.sock");

let controlDirReady = false;

/** Ensure the SSH control socket directory exists with mode 0o700. Returns the control path template. */
export function ensureControlDir(): string {
	if (!controlDirReady) {
		mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
		try {
			chmodSync(CONTROL_DIR, 0o700);
		} catch {
			// best-effort
		}
		controlDirReady = true;
	}
	return CONTROL_PATH;
}

export function getControlPath(): string {
	return CONTROL_PATH;
}

/** Validate SSH key exists and has correct permissions (600 or stricter, skipped on win32). */
export function validateKeyPermissions(keyPath: string): string | undefined {
	try {
		const stats = statSync(keyPath);
		if (!stats.isFile()) return `SSH key is not a file: ${keyPath}`;
		if (process.platform !== "win32") {
			const mode = stats.mode & 0o777;
			if ((mode & 0o077) !== 0) return `SSH key permissions must be 600 or stricter: ${keyPath}`;
		}
		return undefined;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return `SSH key not found: ${keyPath}`;
		return `Failed to check SSH key: ${keyPath}`;
	}
}

// Cache sshpass check per process
let sshpassAvailable: boolean | undefined;

export function hasSshpass(): boolean {
	if (sshpassAvailable !== undefined) return sshpassAvailable;
	try {
		execSync("sshpass -V", { stdio: "ignore" });
		sshpassAvailable = true;
	} catch {
		sshpassAvailable = false;
	}
	return sshpassAvailable;
}

/** Write hosts to `~/.cast/ssh.json` (or custom path). Atomic write (tmp + rename). */
export function saveSshConfig(hosts: SshHost[], path: string = globalSshPath): void {
	const dir = path.slice(0, path.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	const record: Record<string, SshHostConfig> = {};
	for (const h of hosts) {
		const { name, ...cfg } = h;
		record[name] = cfg;
	}
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ hosts: record }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

const COMMON_SSH_KEY_NAMES = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa", "id_ecdsa_sk", "id_ed25519_sk"];

/** Scan ~/.ssh/ for common key files. Returns full paths, sorted ed25519 first. */
export function scanSshKeys(): string[] {
	const sshDir = join(homedir(), ".ssh");
	if (!existsSync(sshDir)) return [];
	try {
		const files = readdirSync(sshDir);
		const found = COMMON_SSH_KEY_NAMES.filter((name) => files.includes(name)).map((name) => join(sshDir, name));
		return found;
	} catch {
		return [];
	}
}

/** Remove the control dir on process exit. Registered once. */
let cleanupRegistered = false;
export function registerControlDirCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	process.on("exit", () => {
		try {
			rmSync(CONTROL_DIR, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});
}
