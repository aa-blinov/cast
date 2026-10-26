import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isSandboxSession } from "./scratchpad.ts";

export interface SandboxSettings {
	git: { safeDirectories: string[] };
	network: {
		allowedDomains: string[];
		deniedDomains: string[];
		strictAllowlist: boolean;
	};
	filesystem: {
		denyRead: string[];
		allowRead: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
}

export interface SandboxInvocation {
	executable: string;
	args: string[];
	env: Record<string, string | undefined>;
}

export interface PreparedSandboxInvocation extends SandboxInvocation {
	cleanup: () => void;
}

export type ShellInvocation = PreparedSandboxInvocation;

const SECRET_ENV_NAME_RE =
	/(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)/i;

/** Environment visible inside the sandbox must not carry host credentials. */
export function sandboxEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV_NAME_RE.test(name)));
}

/** Restrictions shared by every OS; the runtime applies them with native OS mechanisms. */
export function sandboxSettings(cwd: string, tempPath: string, homePath: string): SandboxSettings {
	const protectedPaths = [
		".ssh",
		".aws",
		".azure",
		join(".config", "gcloud"),
		join(".config", "gh"),
		".kube",
		join(".docker", "config.json"),
		".netrc",
		".git-credentials",
		".npmrc",
		".pypirc",
		".vault-token",
		join(".cast", "settings.json"),
		join(".cast", "mcp.json"),
	];
	const envFiles = [join(cwd, ".env"), join(cwd, ".env.*"), join(cwd, "**", ".env"), join(cwd, "**", ".env.*")];
	return {
		git: { safeDirectories: [cwd] },
		network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
		filesystem: {
			denyRead: [homePath, ...protectedPaths.map((path) => join(homePath, path)), ...envFiles],
			allowRead: [cwd],
			allowWrite: [cwd, tempPath],
			denyWrite: envFiles,
		},
	};
}

/** Constructs an argv-only launch so shell metacharacters remain the command's data. */
export function buildSandboxInvocation(
	cliPath: string,
	settingsPath: string,
	shellPath: string,
	command: string,
	env: Record<string, string | undefined>,
): SandboxInvocation {
	return {
		executable: process.execPath,
		args: [cliPath, "--settings", settingsPath, "--", shellPath, "-c", command],
		env: sandboxEnvironment(env),
	};
}

function sandboxCliPath(): string {
	try {
		const entry = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime");
		return join(dirname(entry), "cli.js");
	} catch {
		throw new Error(
			"The OS sandbox runtime is not installed. Reinstall cast with its dependencies before using this sandbox session.",
		);
	}
}

/** Writes an invocation-specific policy so concurrent sessions cannot race a mutable runtime singleton. */
export function prepareSandboxInvocation(
	cwd: string,
	shellPath: string,
	command: string,
	env: Record<string, string | undefined>,
): PreparedSandboxInvocation {
	const cliPath = sandboxCliPath();
	const settingsDir = mkdtempSync(join(tmpdir(), "cast-srt-"));
	try {
		const settingsPath = join(settingsDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify(sandboxSettings(cwd, settingsDir, homedir())), { mode: 0o600 });
		return {
			...buildSandboxInvocation(cliPath, settingsPath, shellPath, command, {
				...env,
				TMPDIR: settingsDir,
				TEMP: settingsDir,
				TMP: settingsDir,
				npm_config_cache: join(settingsDir, "npm-cache"),
				PIP_CACHE_DIR: join(settingsDir, "pip-cache"),
				UV_CACHE_DIR: join(settingsDir, "uv-cache"),
			}),
			cleanup: () => rmSync(settingsDir, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(settingsDir, { recursive: true, force: true });
		throw error;
	}
}

/** Sandbox sessions always use the OS wrapper; an unavailable runtime never falls back to a host shell. */
export function createShellInvocation(
	sessionId: string | undefined,
	cwd: string,
	shellPath: string,
	command: string,
	env: Record<string, string | undefined>,
): ShellInvocation {
	if (sessionId && isSandboxSession(sessionId, cwd)) {
		return prepareSandboxInvocation(cwd, shellPath, command, env);
	}
	return {
		executable: shellPath,
		args: ["-c", command],
		env,
		cleanup: () => {},
	};
}
