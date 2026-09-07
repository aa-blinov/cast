import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
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

export function globalSshPath(): string {
	return join(homedir(), ".cast", "ssh.json");
}
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
	const globalHosts = loadSshConfig(globalSshPath());
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
// 104-byte Unix socket path limit when SSH expands %C. The uid is in the name
// because /tmp is shared: without it, the first user on a multi-user machine to
// create `/tmp/cast-ssh-ctl` owns the directory every other user's cast then
// puts its ControlMaster sockets in.
// CAST_SSH_CONTROL_DIR exists so tests can point this somewhere disposable —
// the real path is shared with whatever cast processes the user has running.
function controlDir(): string {
	return (
		process.env.CAST_SSH_CONTROL_DIR ||
		join("/tmp", `cast-ssh-ctl-${typeof process.getuid === "function" ? process.getuid() : "win"}`)
	);
}

let verifiedControlDir: string | undefined;

/**
 * Ensure the SSH control socket directory exists, is ours, and is private.
 * Returns the control path template.
 *
 * The verification is the point. A multiplexed master socket persists for an
 * hour (ControlPersist=3600) and anyone who can reach it runs commands on the
 * remote host as you, with no key and no password. `mkdirSync(…, {recursive:
 * true})` silently accepts a path that already exists — including a symlink
 * planted by another local user — and the chmod that followed was a swallowed
 * best-effort, so cast would happily put its sockets in someone else's
 * directory (verified: with `/tmp/cast-ssh-ctl` symlinked elsewhere, the
 * socket landed at the link's target). Anything that isn't a real directory we
 * own with mode 0700 is now an error rather than a place to keep credentials.
 */
export function ensureControlDir(): string {
	const dir = controlDir();
	if (verifiedControlDir !== dir) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Not ours to chmod — assertControlDirIsPrivate says so precisely.
		}
		assertControlDirIsPrivate(dir);
		verifiedControlDir = dir;
	}
	return getControlPath();
}

function assertControlDirIsPrivate(dir: string): void {
	const stats = lstatSync(dir);
	if (!stats.isDirectory()) {
		throw new Error(`SSH control path ${dir} is not a directory (a symlink or file is in the way) — remove it.`);
	}
	// Windows reports neither a meaningful uid nor POSIX modes.
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`SSH control directory ${dir} is owned by uid ${stats.uid}, not by you — remove it.`);
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new Error(`SSH control directory ${dir} is accessible to other users — set it to mode 700.`);
	}
}

export function getControlPath(): string {
	return join(controlDir(), "%C.sock");
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
export function saveSshConfig(hosts: SshHost[], path: string = globalSshPath()): void {
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

/**
 * Kept as a no-op: removing the control directory on exit deleted the sockets
 * of every *other* live cast process on the machine (and of this process's own
 * masters, which outlive it by design — ControlPersist=3600). An orphaned
 * master unlinks its own socket when it times out, so there is nothing here to
 * clean up.
 */
export function registerControlDirCleanup(): void {}
